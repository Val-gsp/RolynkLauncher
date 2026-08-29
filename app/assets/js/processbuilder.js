const AdmZip                = require('adm-zip')
const child_process         = require('child_process')
const crypto                = require('crypto')
const fs                    = require('fs-extra')
const { getMojangOS, isLibraryCompatible, mcVersionAtLeast }  = require('helios-core/common')
const { Type }              = require('helios-distribution-types')
const os                    = require('os')
const path                  = require('path')

const ConfigManager            = require('./configmanager')
const ModVault                 = require('./modvault')

// Logger sécurisé : les noms de fichiers .jar/.zip, URLs et jetons présents
// dans les arguments logués sont automatiquement rédigés (voir securelog.js).
const logger = require('./securelog').getSecureLogger('ProcessBuilder')


/**
 * Only forge and fabric are top level mod loaders.
 * 
 * Forge 1.13+ launch logic is similar to fabrics, for now using usingFabricLoader flag to
 * change minor details when needed.
 * 
 * Rewrite of this module may be needed in the future.
 */
class ProcessBuilder {

    constructor(distroServer, vanillaManifest, modManifest, authUser, launcherVersion){
        this.gameDir = path.join(ConfigManager.getInstanceDirectory(), distroServer.rawServer.id)
        this.commonDir = ConfigManager.getCommonDirectory()
        this.server = distroServer
        this.vanillaManifest = vanillaManifest
        this.modManifest = modManifest
        this.authUser = authUser
        this.launcherVersion = launcherVersion
        this.forgeModListFile = path.join(this.gameDir, 'forgeMods.list') // 1.13+
        this.fmlDir = path.join(this.gameDir, 'forgeModList.json')
        this.llDir = path.join(this.gameDir, 'liteloaderModList.json')
        this.libPath = path.join(this.commonDir, 'libraries')

        this.usingLiteLoader = false
        this.usingFabricLoader = false
        this.llPath = null
    }
    
    /**
     * Convienence method to run the functions typically used to build a process.
     */
    build(){
        fs.ensureDirSync(this.gameDir)

        // Seed default game options on first launch only. The file is never
        // touched again afterwards, so in-game changes made by players persist.
        const optionsPath = path.join(this.gameDir, 'options.txt')
        if(!fs.existsSync(optionsPath)){
            fs.writeFileSync(optionsPath, 'guiScale:2\n', 'UTF-8')
        }

        // Mode Patate : préréglage vidéo bas régime écrit UNE SEULE FOIS au
        // moment de l'activation (voir ConfigManager#getPotatoModeApplied),
        // pas à chaque lancement — un changement fait par le joueur en jeu
        // ensuite reste acquis, même en Mode Patate. Réinitialisé à false
        // par settings.js à chaque (ré)activation pour réappliquer le preset.
        if(ConfigManager.getPotatoMode() && !ConfigManager.getPotatoModeApplied()){
            this._applyPotatoModePreset()
            ConfigManager.setPotatoModeApplied(true)
            ConfigManager.save()
        }

        this._seedDefaultModConfigs()

        // Only distribution-declared content may load: purge player-added
        // mods, shaderpacks and resourcepacks before every launch. Vaulted
        // mods (Rolynk V1, see gen-distro.js) don't declare a mods/-prefixed
        // artifact path anymore, so this also acts as a crash-safety net:
        // any decrypted jar left behind by a previous session that didn't
        // shut down cleanly gets wiped here before we materialize a fresh
        // copy below.
        this._purgeUnauthorizedFiles()

        // Decrypt this session's vaulted mods (if any) from the local vault
        // directly into gameDir/mods, immediately before the JVM can read
        // them. The plaintext copies are destroyed again in the child
        // 'close' handler below, so they only exist on disk for the
        // lifetime of the game process. See modvault.js and
        // protection_mods_launcher.md.
        this._materializeVaultedMods()

        // Les resource packs distribués doivent être actifs et dans le bon
        // ordre dès la connexion — pas juste téléchargés et laissés en
        // "Available" à sélectionner manuellement. Forcé à CHAQUE lancement
        // (comme _purgeUnauthorizedFiles ci-dessus) : cohérent avec le reste
        // du launcher où le contenu du serveur n'est pas laissé au choix du
        // joueur.
        this._forceResourcePackSelection()

        const tempNativePath = path.join(os.tmpdir(), ConfigManager.getTempNativeFolder(), crypto.pseudoRandomBytes(16).toString('hex'))
        process.throwDeprecation = true
        this.setupLiteLoader()
        logger.info('Using liteloader:', this.usingLiteLoader)
        this.usingFabricLoader = this.server.modules.some(mdl => mdl.rawModule.type === Type.Fabric)
        logger.info('Using fabric loader:', this.usingFabricLoader)
        const modObj = this.resolveModConfiguration(ConfigManager.getModConfiguration(this.server.rawServer.id).mods, this.server.modules)
        
        // Mod list below 1.13
        // Fabric only supports 1.14+
        if(!mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            this.constructJSONModList('forge', modObj.fMods, true)
            if(this.usingLiteLoader){
                this.constructJSONModList('liteloader', modObj.lMods, true)
            }
        }
        
        const uberModArr = modObj.fMods.concat(modObj.lMods)
        let args = this.constructJVMArguments(uberModArr, tempNativePath)

        if(mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            args = args.concat(this.constructModList(modObj.fMods))
        }

        // Hide access token
        const loggableArgs = [...args]
        loggableArgs[loggableArgs.findIndex(x => x === this.authUser.accessToken)] = '**********'

        logger.info('Launch Arguments:', loggableArgs)

        const child = child_process.spawn(ConfigManager.getJavaExecutable(this.server.rawServer.id), args, {
            cwd: this.gameDir,
            detached: ConfigManager.getLaunchDetached()
        })

        if(ConfigManager.getLaunchDetached()){
            child.unref()
        }

        child.stdout.setEncoding('utf8')
        child.stderr.setEncoding('utf8')

        child.stdout.on('data', (data) => {
            data.trim().split('\n').forEach(x => console.log(`\x1b[32m[Minecraft]\x1b[0m ${x}`))
            
        })
        child.stderr.on('data', (data) => {
            data.trim().split('\n').forEach(x => console.log(`\x1b[31m[Minecraft]\x1b[0m ${x}`))
        })
        child.on('close', (code) => {
            logger.info('Exited with code', code)
            fs.remove(tempNativePath, (err) => {
                if(err){
                    logger.warn('Error while deleting temp dir', err)
                } else {
                    logger.info('Temp dir deleted successfully.')
                }
            })
            // Securely wipe any decrypted mod jars now that the JVM has
            // exited. This is the key cleanup step for mod protection: it
            // bounds the plaintext exposure window to the lifetime of the
            // game process instead of leaving jars on disk indefinitely
            // between launches. No-op for servers with no vaulted mods.
            ModVault.shred(path.join(this.gameDir, 'mods'))
        })

        return child
    }

    /**
     * Decrypts every vault-managed File module for this server directly into
     * gameDir/mods, under randomized file names. Modules are recognized by
     * their artifact.path being published under `.rt-cache/` (see
     * tools/gen-distro.js, currently only Rolynk V1) rather than the classic
     * `mods/` prefix. The on-disk .rt-cache copy (kept there by the normal
     * download/verify step so it can be incrementally updated) is (re-)sealed
     * into the encrypted vault only when its content actually changed.
     */
    _materializeVaultedMods(){
        const vaultModules = this._collectVaultModules(this.server.modules)
        if(vaultModules.length === 0){
            return
        }

        const modsDir = path.join(this.gameDir, 'mods')
        fs.ensureDirSync(modsDir)

        const entries = []
        for(const mdl of vaultModules){
            const cachePath = mdl.getPath()
            if(!fs.existsSync(cachePath)){
                // Not synced yet this run (first-time download failed or was
                // skipped). Nothing to vault; ProcessBuilder should not
                // normally be reached in that case.
                continue
            }
            // File-type modules that declare an artifact.path (our case) never
            // get maven components resolved by helios-core (mavenComponents
            // stays null), so getVersionlessMavenIdentifier() always throws
            // for them. Use the module's own declared id instead: stable,
            // always present regardless of module type.
            const vaultId = ModVault.vaultIdFor(mdl.rawModule.id)
            const plaintext = fs.readFileSync(cachePath)
            const sha256 = crypto.createHash('sha256').update(plaintext).digest('hex')
            if(!ModVault.hasCurrentEntry(vaultId, sha256)){
                ModVault.sealBuffer(vaultId, plaintext, sha256)
                logger.info('Sealed an updated content entry into the local vault.')
            }
            entries.push({ vaultId })
        }

        ModVault.unsealInto(entries, modsDir)
    }

    /**
     * Recursively collects every File-type module (including submodules)
     * whose artifact is published for the encrypted vault.
     *
     * @param {Array.<Object>} mdls Modules to scan.
     * @param {Array.<Object>} out Accumulator (recursive calls only).
     * @returns {Array.<Object>} The vault-managed modules found.
     */
    _collectVaultModules(mdls, out = []){
        for(const mdl of mdls){
            const artifactPath = mdl.rawModule.artifact != null ? mdl.rawModule.artifact.path : null
            if(mdl.rawModule.type === Type.File && artifactPath != null && artifactPath.replace(/\\/g, '/').startsWith('.rt-cache/')){
                out.push(mdl)
            }
            if(mdl.subModules.length > 0){
                this._collectVaultModules(mdl.subModules, out)
            }
        }
        return out
    }

    /**
     * Remove any file the distribution does not declare from the instance's
     * mods folder, and empty the shaderpacks/resourcepacks folders entirely.
     * Players cannot side-load content this way: anything they drop in is
     * deleted on the next launch.
     */
    _purgeUnauthorizedFiles(){
        // Fichiers déclarés par la distribution, groupés par dossier de destination
        // (mods/, shaderpacks/, resourcepacks/) — un fichier local est conservé
        // seulement s'il figure dans la liste correspondante.
        const allowedByDir = { mods: new Set(), shaderpacks: new Set(), resourcepacks: new Set() }
        for(const mdl of this.server.modules){
            const artifactPath = mdl.rawModule.artifact != null ? mdl.rawModule.artifact.path : null
            if(mdl.rawModule.type === Type.File && artifactPath != null){
                const normalized = artifactPath.replace(/\\/g, '/')
                for(const dirName of Object.keys(allowedByDir)){
                    if(normalized.startsWith(`${dirName}/`)){
                        allowedByDir[dirName].add(path.basename(artifactPath).toLowerCase())
                    }
                }
            }
        }

        for(const dirName of Object.keys(allowedByDir)){
            const dir = path.join(this.gameDir, dirName)
            if(!fs.existsSync(dir)) continue
            const allowed = allowedByDir[dirName]
            for(const f of fs.readdirSync(dir)){
                const full = path.join(dir, f)
                if(fs.statSync(full).isFile() && !allowed.has(f.toLowerCase())){
                    logger.info(`Purging unauthorized ${dirName} file:`, f)
                    fs.removeSync(full)
                }
            }
        }
    }

    /**
     * Désactive le brouillard "Dynamic Surroundings" par défaut, à la première
     * création de l'instance uniquement (jamais réécrit ensuite, comme
     * options.txt ci-dessus — un réglage modifié par le joueur en jeu persiste).
     *
     * Constat : Dynamic Surroundings active par défaut (voir sa classe
     * Configuration$FogOptions, désassemblée en l'absence de sources
     * publiques : enableFogEffects/enableMorningFog/enableBiomeFog/
     * enableWeatherFog = true) un brouillard biome+météo+matin qui, sur
     * certains biomes/seeds, réduit la visibilité à 1-2 chunks — signalé par
     * un joueur comme anormal sur Rolynk V1 après un changement de seed.
     * Le fichier vit dans config/dsurround/dsurround.json (JSON simple via
     * Gson, pas TOML — confirmé par l'annotation ConfigPlacement du mod) ;
     * un objet partiel suffit, Gson ne réécrit que les clés présentes et
     * conserve les valeurs par défaut du constructeur pour le reste.
     */
    _seedDefaultModConfigs(){
        const hasDynamicSurroundings = this.server.modules.some(
            mdl => mdl.rawModule.type === Type.File
                && /^dynamicsurroundings-/i.test(mdl.rawModule.name || ''))
        if(!hasDynamicSurroundings) return

        const configPath = path.join(this.gameDir, 'config', 'dsurround', 'dsurround.json')
        if(fs.existsSync(configPath)) return

        fs.ensureDirSync(path.dirname(configPath))
        fs.writeFileSync(configPath, JSON.stringify({
            fogOptions: {
                enableFogEffects: false,
                enableMorningFog: false,
                enableBiomeFog: false,
                enableWeatherFog: false
            }
        }, null, 2), 'UTF-8')
    }

    /**
     * Ordre de priorité par défaut (du moins prioritaire au plus prioritaire —
     * un pack plus loin dans ce tableau écrase les textures des packs
     * précédents en cas de conflit). Ordre exact confirmé par l'utilisateur
     * à partir d'une capture d'écran complète du panneau "Selected" — top de
     * l'écran = plus prioritaire = fin de ce tableau (options.txt liste du
     * moins prioritaire au plus prioritaire).
     *
     * Identifiants "mod/<modid>:resourcepacks/<nom>" et "builtin/..." vérifiés
     * en désassemblant les jars des mods concernés (RolynkRP, Mining & Placing
     * Animations, HoldMyItems) — pas une supposition.
     *
     * Ordre confirmé explicitement par l'utilisateur (better dog > better cats
     * > default mining > FA+quivers > FA+spiders > FA+Emissive > FA+Objects >
     * FA+Details > Fresh Music discs > Light leak > Visual effect+ >
     * armory-conglomery > Bray's zombie overhaul > hmi 3d buckets >
     * benigamer'enhanced > freshAnimations, du plus prioritaire au moins
     * prioritaire).
     *
     * "Actually 3D Stuff.zip" et "JustExpressions_v1.2.1.zip" n'étaient pas
     * dans cette liste (ni confirmés ni exclus explicitement) : gardés par
     * précaution en priorité basse (avec vanilla/mod_resources), pour ne pas
     * perturber l'ordre confirmé ci-dessus — à repositionner si besoin.
     */
    static RESOURCE_PACK_ORDER = [
        'vanilla',
        'mod_resources',
        'file/Actually 3D Stuff.zip',
        'file/JustExpressions_v1.2.1.zip',
        'file/FreshAnimations_v1.10.4.zip',
        "file/Benigamer'enhanced visuals 1.9.zip",
        'builtin/add_pack_finders_test', // HMI 3D Buckets (holdmyitemsnf)
        "file/Bray's Zombie Overhaul v1.4.zip",
        'file/armory-conglomery-v2.2.zip',
        'file/Visual Effects+.zip',
        'file/§eLight §6Leak §8[v1.3.0].zip',
        'file/Fresh Music Discs 1.2.1.zip',
        'file/FA+Details-v2.2.1.zip',
        'file/FA+Objects-v2.1.2.zip',
        'file/FA+Emissive-v1.6.zip',
        'file/FA+Spiders-v2.2.zip',
        'file/FA+Quivers-v2.2.zip',
        'mod/mining_and_placing_animations:resourcepacks/default_animations',
        'mod/rolynkrp:resourcepacks/better_cats',
        'mod/rolynkrp:resourcepacks/better_dogs'
    ]

    /**
     * Mode Patate : fusionne un préréglage vidéo bas régime dans
     * options.txt (une seule ligne par clé, comme _forceResourcePackSelection
     * ci-dessous, mais appelé une seule fois — voir le commentaire dans
     * build()). Valeurs vanilla Minecraft 1.21 : distances de rendu/
     * simulation réduites, particules et ombres d'entités au minimum,
     * lissage/mipmaps désactivés, images/s plafonnées à 120 sans V-Sync
     * (un plafond raisonnable plutôt qu'un FPS "illimité", pour éviter la
     * surchauffe/throttling sur un petit PC portable). Toutes les autres
     * options du joueur (touches, son, affichage...) restent intactes.
     */
    _applyPotatoModePreset(){
        const optionsPath = path.join(this.gameDir, 'options.txt')
        let lines = []
        if(fs.existsSync(optionsPath)){
            lines = fs.readFileSync(optionsPath, 'UTF-8').split('\n').filter(l => l.length > 0)
        }

        const preset = {
            renderDistance: 8,
            simulationDistance: 6,
            particles: 2,
            graphicsMode: 0,
            ao: 0,
            entityShadows: false,
            biomeBlendRadius: 0,
            cloudStatus: 'fast',
            mipmapLevels: 0,
            maxFps: 120,
            enableVsync: false
        }

        for(const [key, value] of Object.entries(preset)){
            const newLine = `${key}:${value}`
            const idx = lines.findIndex(l => l.startsWith(`${key}:`))
            if(idx >= 0){
                lines[idx] = newLine
            } else {
                lines.push(newLine)
            }
        }

        fs.writeFileSync(optionsPath, lines.join('\n') + '\n', 'UTF-8')
    }

    /**
     * Force la sélection + l'ordre des resource packs distribués dans
     * options.txt, à chaque lancement. Sans ça, les packs sont bien
     * téléchargés mais restent en "Available" (non sélectionnés) tant que le
     * joueur ne les active pas manuellement un par un dans le bon ordre.
     *
     * N'écrit QUE la ligne resourcePacks: (et supprime incompatibleResourcePacks:,
     * recalculée par le jeu lui-même) — toutes les autres options du joueur
     * (touches, son, affichage...) restent intactes.
     */
    _forceResourcePackSelection(){
        const declaredFiles = new Set()
        for(const mdl of this.server.modules){
            const artifactPath = mdl.rawModule.artifact != null ? mdl.rawModule.artifact.path : null
            if(mdl.rawModule.type === Type.File && artifactPath != null){
                const normalized = artifactPath.replace(/\\/g, '/')
                if(normalized.startsWith('resourcepacks/')){
                    declaredFiles.add(path.basename(artifactPath))
                }
            }
        }
        if(declaredFiles.size === 0) return // ce serveur ne distribue aucun resourcepack

        const isFileEntry = id => id.startsWith('file/')
        const fileName = id => id.slice('file/'.length)

        // Garde l'ordre voulu pour tout ce qui est encore distribué, puis
        // ajoute à la fin tout nouveau pack pas encore dans la liste ci-dessus
        // (filet de sécurité : jamais un pack silencieusement non sélectionné).
        const ordered = ProcessBuilder.RESOURCE_PACK_ORDER.filter(
            id => !isFileEntry(id) || declaredFiles.has(fileName(id)))
        const known = new Set(ordered.filter(isFileEntry).map(fileName))
        for(const f of declaredFiles){
            if(!known.has(f)) ordered.push(`file/${f}`)
        }

        const optionsPath = path.join(this.gameDir, 'options.txt')
        let lines = []
        if(fs.existsSync(optionsPath)){
            lines = fs.readFileSync(optionsPath, 'UTF-8').split('\n').filter(l => l.length > 0)
        }
        const newLine = `resourcePacks:${JSON.stringify(ordered)}`
        const idx = lines.findIndex(l => l.startsWith('resourcePacks:'))
        if(idx >= 0){
            lines[idx] = newLine
        } else {
            lines.push(newLine)
        }
        lines = lines.filter(l => !l.startsWith('incompatibleResourcePacks:'))

        fs.writeFileSync(optionsPath, lines.join('\n') + '\n', 'UTF-8')
    }

    /**
     * Get the platform specific classpath separator. On windows, this is a semicolon.
     * On Unix, this is a colon.
     *
     * @returns {string} The classpath separator for the current operating system.
     */
    static getClasspathSeparator() {
        return process.platform === 'win32' ? ';' : ':'
    }

    /**
     * Determine if an optional mod is enabled from its configuration value. If the
     * configuration value is null, the required object will be used to
     * determine if it is enabled.
     * 
     * A mod is enabled if:
     *   * The configuration is not null and one of the following:
     *     * The configuration is a boolean and true.
     *     * The configuration is an object and its 'value' property is true.
     *   * The configuration is null and one of the following:
     *     * The required object is null.
     *     * The required object's 'def' property is null or true.
     * 
     * @param {Object | boolean} modCfg The mod configuration object.
     * @param {Object} required Optional. The required object from the mod's distro declaration.
     * @returns {boolean} True if the mod is enabled, false otherwise.
     */
    static isModEnabled(modCfg, required = null){
        return modCfg != null ? ((typeof modCfg === 'boolean' && modCfg) || (typeof modCfg === 'object' && (typeof modCfg.value !== 'undefined' ? modCfg.value : true))) : required != null ? required.def : true
    }

    /**
     * Function which performs a preliminary scan of the top level
     * mods. If liteloader is present here, we setup the special liteloader
     * launch options. Note that liteloader is only allowed as a top level
     * mod. It must not be declared as a submodule.
     */
    setupLiteLoader(){
        for(let ll of this.server.modules){
            if(ll.rawModule.type === Type.LiteLoader){
                if(!ll.getRequired().value){
                    const modCfg = ConfigManager.getModConfiguration(this.server.rawServer.id).mods
                    if(ProcessBuilder.isModEnabled(modCfg[ll.getVersionlessMavenIdentifier()], ll.getRequired())){
                        if(fs.existsSync(ll.getPath())){
                            this.usingLiteLoader = true
                            this.llPath = ll.getPath()
                        }
                    }
                } else {
                    if(fs.existsSync(ll.getPath())){
                        this.usingLiteLoader = true
                        this.llPath = ll.getPath()
                    }
                }
            }
        }
    }

    /**
     * Resolve an array of all enabled mods. These mods will be constructed into
     * a mod list format and enabled at launch.
     * 
     * @param {Object} modCfg The mod configuration object.
     * @param {Array.<Object>} mdls An array of modules to parse.
     * @returns {{fMods: Array.<Object>, lMods: Array.<Object>}} An object which contains
     * a list of enabled forge mods and litemods.
     */
    resolveModConfiguration(modCfg, mdls){
        let fMods = []
        let lMods = []

        for(let mdl of mdls){
            const type = mdl.rawModule.type
            if(type === Type.ForgeMod || type === Type.LiteMod || type === Type.LiteLoader || type === Type.FabricMod){
                const o = !mdl.getRequired().value
                const e = ProcessBuilder.isModEnabled(modCfg[mdl.getVersionlessMavenIdentifier()], mdl.getRequired())
                if(!o || (o && e)){
                    if(mdl.subModules.length > 0){
                        const v = this.resolveModConfiguration(modCfg[mdl.getVersionlessMavenIdentifier()].mods, mdl.subModules)
                        fMods = fMods.concat(v.fMods)
                        lMods = lMods.concat(v.lMods)
                        if(type === Type.LiteLoader){
                            continue
                        }
                    }
                    if(type === Type.ForgeMod || type === Type.FabricMod){
                        fMods.push(mdl)
                    } else {
                        lMods.push(mdl)
                    }
                }
            }
        }

        return {
            fMods,
            lMods
        }
    }

    _lteMinorVersion(version) {
        return Number(this.modManifest.id.split('-')[0].split('.')[1]) <= Number(version)
    }

    /**
     * Test to see if this version of forge requires the absolute: prefix
     * on the modListFile repository field.
     */
    _requiresAbsolute(){
        try {
            if(this._lteMinorVersion(9)) {
                return false
            }
            const ver = this.modManifest.id.split('-')[2]
            const pts = ver.split('.')
            const min = [14, 23, 3, 2655]
            for(let i=0; i<pts.length; i++){
                const parsed = Number.parseInt(pts[i])
                if(parsed < min[i]){
                    return false
                } else if(parsed > min[i]){
                    return true
                }
            }
        } catch (_err) {
            // We know old forge versions follow this format.
            // Error must be caused by newer version.
        }
        
        // Equal or errored
        return true
    }

    /**
     * Construct a mod list json object.
     * 
     * @param {'forge' | 'liteloader'} type The mod list type to construct.
     * @param {Array.<Object>} mods An array of mods to add to the mod list.
     * @param {boolean} save Optional. Whether or not we should save the mod list file.
     */
    constructJSONModList(type, mods, save = false){
        const modList = {
            repositoryRoot: ((type === 'forge' && this._requiresAbsolute()) ? 'absolute:' : '') + path.join(this.commonDir, 'modstore')
        }

        const ids = []
        if(type === 'forge'){
            for(let mod of mods){
                ids.push(mod.getExtensionlessMavenIdentifier())
            }
        } else {
            for(let mod of mods){
                ids.push(mod.getMavenIdentifier())
            }
        }
        modList.modRef = ids
        
        if(save){
            const json = JSON.stringify(modList, null, 4)
            fs.writeFileSync(type === 'forge' ? this.fmlDir : this.llDir, json, 'UTF-8')
        }

        return modList
    }

    /**
     * Construct the mod argument list for forge 1.13 and Fabric
     * 
     * @param {Array.<Object>} mods An array of mods to add to the mod list.
     */
    constructModList(mods) {
        const writeBuffer = mods.map(mod => {
            return this.usingFabricLoader ? mod.getPath() : mod.getExtensionlessMavenIdentifier()
        }).join('\n')

        if(writeBuffer) {
            fs.writeFileSync(this.forgeModListFile, writeBuffer, 'UTF-8')
            return this.usingFabricLoader ? [
                '--fabric.addMods',
                `@${this.forgeModListFile}`
            ] : [
                '--fml.mavenRoots',
                path.join('..', '..', 'common', 'modstore'),
                '--fml.modLists',
                this.forgeModListFile
            ]
        } else {
            return []
        }

    }

    _processAutoConnectArg(args){
        if(ConfigManager.getAutoConnect() && this.server.rawServer.autoconnect){
            if(mcVersionAtLeast('1.20', this.server.rawServer.minecraftVersion)){
                args.push('--quickPlayMultiplayer')
                args.push(`${this.server.hostname}:${this.server.port}`)
            } else {
                args.push('--server')
                args.push(this.server.hostname)
                args.push('--port')
                args.push(this.server.port)
            }
        }
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    constructJVMArguments(mods, tempNativePath){
        if(mcVersionAtLeast('1.13', this.server.rawServer.minecraftVersion)){
            return this._constructJVMArguments113(mods, tempNativePath)
        } else {
            return this._constructJVMArguments112(mods, tempNativePath)
        }
    }

    /**
     * Mode Patate : sur une petite config, un -Xmx trop élevé par rapport à
     * la RAM physique dispo fait swapper l'OS pendant la partie, ce qui
     * coûte largement plus de FPS que n'importe quel réglage vidéo. On
     * plafonne donc la mémoire effective de CE lancement uniquement, sans
     * jamais modifier la valeur enregistrée dans les paramètres (toujours
     * visible/éditable normalement dans l'onglet Java, Mode Patate ou non).
     *
     * @param {string} ramStr Valeur telle que retournée par ConfigManager.getMaxRAM/getMinRAM (ex. "4G", "512M").
     * @returns {string} La même valeur, ou le plafond Mode Patate si dépassé.
     */
    _clampRamForPotatoMode(ramStr){
        if(!ConfigManager.getPotatoMode()) return ramStr
        const currentMB = ramStr.endsWith('G') ? Number.parseFloat(ramStr) * 1024 : Number.parseFloat(ramStr)
        const capMB = ConfigManager.getPotatoModeRamCapGB() * 1024
        return currentMB > capMB ? `${capMB}M` : ramStr
    }

    /**
     * Mode Patate : réglages G1GC orientés petit tas mémoire — réduit la
     * taille des régions pour limiter les pauses de garbage collection
     * perceptibles comme des micro-saccades plutôt que de viser un gain de
     * FPS moyen. Best-effort, pas une garantie universelle selon le
     * matériel.
     *
     * @returns {Array.<string>}
     */
    _potatoJvmArgs(){
        if(!ConfigManager.getPotatoMode()) return []
        return [
            '-XX:+UnlockExperimentalVMOptions',
            '-XX:G1NewSizePercent=20',
            '-XX:G1ReservePercent=20',
            '-XX:MaxGCPauseMillis=50',
            '-XX:G1HeapRegionSize=16M'
        ]
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * This function is for 1.12 and below.
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    _constructJVMArguments112(mods, tempNativePath){

        let args = []

        // Classpath Argument
        args.push('-cp')
        args.push(this.classpathArg(mods, tempNativePath).join(ProcessBuilder.getClasspathSeparator()))

        // Java Arguments
        if(process.platform === 'darwin'){
            args.push('-Xdock:name=RolynkLauncher')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + this._clampRamForPotatoMode(ConfigManager.getMaxRAM(this.server.rawServer.id)))
        args.push('-Xms' + this._clampRamForPotatoMode(ConfigManager.getMinRAM(this.server.rawServer.id)))
        args = args.concat(this._potatoJvmArgs())
        args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id))
        args.push('-Djava.library.path=' + tempNativePath)

        // Main Java Class
        args.push(this.modManifest.mainClass)

        // Forge Arguments
        args = args.concat(this._resolveForgeArgs())

        return args
    }

    /**
     * Construct the argument array that will be passed to the JVM process.
     * This function is for 1.13+
     * 
     * Note: Required Libs https://github.com/MinecraftForge/MinecraftForge/blob/af98088d04186452cb364280340124dfd4766a5c/src/fmllauncher/java/net/minecraftforge/fml/loading/LibraryFinder.java#L82
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the full JVM arguments for this process.
     */
    _constructJVMArguments113(mods, tempNativePath){

        const argDiscovery = /\${*(.*)}/

        // JVM Arguments First
        let args = this.vanillaManifest.arguments.jvm

        // Debug securejarhandler
        // args.push('-Dbsl.debug=true')

        if(this.modManifest.arguments.jvm != null) {
            for(const argStr of this.modManifest.arguments.jvm) {
                args.push(argStr
                    .replaceAll('${library_directory}', this.libPath)
                    .replaceAll('${classpath_separator}', ProcessBuilder.getClasspathSeparator())
                    .replaceAll('${version_name}', this.modManifest.id)
                )
            }
        }

        //args.push('-Dlog4j.configurationFile=D:\\WesterosCraft\\game\\common\\assets\\log_configs\\client-1.12.xml')

        // Java Arguments
        if(process.platform === 'darwin'){
            args.push('-Xdock:name=RolynkLauncher')
            args.push('-Xdock:icon=' + path.join(__dirname, '..', 'images', 'minecraft.icns'))
        }
        args.push('-Xmx' + this._clampRamForPotatoMode(ConfigManager.getMaxRAM(this.server.rawServer.id)))
        args.push('-Xms' + this._clampRamForPotatoMode(ConfigManager.getMinRAM(this.server.rawServer.id)))
        args = args.concat(this._potatoJvmArgs())
        args = args.concat(ConfigManager.getJVMOptions(this.server.rawServer.id))

        // Main Java Class
        args.push(this.modManifest.mainClass)

        // Vanilla Arguments
        args = args.concat(this.vanillaManifest.arguments.game)

        for(let i=0; i<args.length; i++){
            if(typeof args[i] === 'object' && args[i].rules != null){
                
                let checksum = 0
                for(let rule of args[i].rules){
                    if(rule.os != null){
                        if(rule.os.name === getMojangOS()
                            && (rule.os.version == null || new RegExp(rule.os.version).test(os.release))){
                            if(rule.action === 'allow'){
                                checksum++
                            }
                        } else {
                            if(rule.action === 'disallow'){
                                checksum++
                            }
                        }
                    } else if(rule.features != null){
                        // We don't have many 'features' in the index at the moment.
                        // This should be fine for a while.
                        if(rule.features.has_custom_resolution != null && rule.features.has_custom_resolution === true){
                            if(ConfigManager.getFullscreen()){
                                args[i].value = [
                                    '--fullscreen',
                                    'true'
                                ]
                            }
                            checksum++
                        }
                    }
                }

                // TODO splice not push
                if(checksum === args[i].rules.length){
                    if(typeof args[i].value === 'string'){
                        args[i] = args[i].value
                    } else if(typeof args[i].value === 'object'){
                        //args = args.concat(args[i].value)
                        args.splice(i, 1, ...args[i].value)
                    }

                    // Decrement i to reprocess the resolved value
                    i--
                } else {
                    args[i] = null
                }

            } else if(typeof args[i] === 'string'){
                if(argDiscovery.test(args[i])){
                    const identifier = args[i].match(argDiscovery)[1]
                    let val = null
                    switch(identifier){
                        case 'auth_player_name':
                            val = this.authUser.displayName.trim()
                            break
                        case 'version_name':
                            //val = vanillaManifest.id
                            val = this.server.rawServer.id
                            break
                        case 'game_directory':
                            val = this.gameDir
                            break
                        case 'assets_root':
                            val = path.join(this.commonDir, 'assets')
                            break
                        case 'assets_index_name':
                            val = this.vanillaManifest.assets
                            break
                        case 'auth_uuid':
                            val = this.authUser.uuid.trim()
                            break
                        case 'auth_access_token':
                            val = this.authUser.accessToken
                            break
                        case 'user_type':
                            val = this.authUser.type === 'microsoft' ? 'msa' : 'mojang'
                            break
                        case 'version_type':
                            val = this.vanillaManifest.type
                            break
                        case 'resolution_width':
                            val = ConfigManager.getGameWidth()
                            break
                        case 'resolution_height':
                            val = ConfigManager.getGameHeight()
                            break
                        case 'natives_directory':
                            val = args[i].replace(argDiscovery, tempNativePath)
                            break
                        case 'launcher_name':
                            val = args[i].replace(argDiscovery, 'Helios-Launcher')
                            break
                        case 'launcher_version':
                            val = args[i].replace(argDiscovery, this.launcherVersion)
                            break
                        case 'classpath':
                            val = this.classpathArg(mods, tempNativePath).join(ProcessBuilder.getClasspathSeparator())
                            break
                    }
                    if(val != null){
                        args[i] = val
                    }
                }
            }
        }

        // Autoconnect
        this._processAutoConnectArg(args)
        

        // Forge Specific Arguments
        args = args.concat(this.modManifest.arguments.game)

        // Filter null values
        args = args.filter(arg => {
            return arg != null
        })

        return args
    }

    /**
     * Resolve the arguments required by forge.
     * 
     * @returns {Array.<string>} An array containing the arguments required by forge.
     */
    _resolveForgeArgs(){
        const mcArgs = this.modManifest.minecraftArguments.split(' ')
        const argDiscovery = /\${*(.*)}/

        // Replace the declared variables with their proper values.
        for(let i=0; i<mcArgs.length; ++i){
            if(argDiscovery.test(mcArgs[i])){
                const identifier = mcArgs[i].match(argDiscovery)[1]
                let val = null
                switch(identifier){
                    case 'auth_player_name':
                        val = this.authUser.displayName.trim()
                        break
                    case 'version_name':
                        //val = vanillaManifest.id
                        val = this.server.rawServer.id
                        break
                    case 'game_directory':
                        val = this.gameDir
                        break
                    case 'assets_root':
                        val = path.join(this.commonDir, 'assets')
                        break
                    case 'assets_index_name':
                        val = this.vanillaManifest.assets
                        break
                    case 'auth_uuid':
                        val = this.authUser.uuid.trim()
                        break
                    case 'auth_access_token':
                        val = this.authUser.accessToken
                        break
                    case 'user_type':
                        val = this.authUser.type === 'microsoft' ? 'msa' : 'mojang'
                        break
                    case 'user_properties': // 1.8.9 and below.
                        val = '{}'
                        break
                    case 'version_type':
                        val = this.vanillaManifest.type
                        break
                }
                if(val != null){
                    mcArgs[i] = val
                }
            }
        }

        // Autoconnect to the selected server.
        this._processAutoConnectArg(mcArgs)

        // Prepare game resolution
        if(ConfigManager.getFullscreen()){
            mcArgs.push('--fullscreen')
            mcArgs.push(true)
        } else {
            mcArgs.push('--width')
            mcArgs.push(ConfigManager.getGameWidth())
            mcArgs.push('--height')
            mcArgs.push(ConfigManager.getGameHeight())
        }
        
        // Mod List File Argument
        mcArgs.push('--modListFile')
        if(this._lteMinorVersion(9)) {
            mcArgs.push(path.basename(this.fmlDir))
        } else {
            mcArgs.push('absolute:' + this.fmlDir)
        }
        

        // LiteLoader
        if(this.usingLiteLoader){
            mcArgs.push('--modRepo')
            mcArgs.push(this.llDir)

            // Set first arg to liteloader tweak class
            mcArgs.unshift('com.mumfrey.liteloader.launch.LiteLoaderTweaker')
            mcArgs.unshift('--tweakClass')
        }

        return mcArgs
    }

    /**
     * Ensure that the classpath entries all point to jar files.
     * 
     * @param {Array.<String>} list Array of classpath entries.
     */
    _processClassPathList(list) {

        const ext = '.jar'
        const extLen = ext.length
        for(let i=0; i<list.length; i++) {
            const extIndex = list[i].indexOf(ext)
            if(extIndex > -1 && extIndex  !== list[i].length - extLen) {
                list[i] = list[i].substring(0, extIndex + extLen)
            }
        }

    }

    /**
     * Resolve the full classpath argument list for this process. This method will resolve all Mojang-declared
     * libraries as well as the libraries declared by the server. Since mods are permitted to declare libraries,
     * this method requires all enabled mods as an input
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {Array.<string>} An array containing the paths of each library required by this process.
     */
    classpathArg(mods, tempNativePath){
        let cpArgs = []

        if(!mcVersionAtLeast('1.17', this.server.rawServer.minecraftVersion) || this.usingFabricLoader) {
            // Add the version.jar to the classpath.
            // Must not be added to the classpath for Forge 1.17+.
            const version = this.vanillaManifest.id
            cpArgs.push(path.join(this.commonDir, 'versions', version, version + '.jar'))
        }
        

        if(this.usingLiteLoader){
            cpArgs.push(this.llPath)
        }

        // Resolve the Mojang declared libraries.
        const mojangLibs = this._resolveMojangLibraries(tempNativePath)

        // Resolve the server declared libraries.
        const servLibs = this._resolveServerLibraries(mods)

        // Merge libraries, server libs with the same
        // maven identifier will override the mojang ones.
        // Ex. 1.7.10 forge overrides mojang's guava with newer version.
        const finalLibs = {...mojangLibs, ...servLibs}
        cpArgs = cpArgs.concat(Object.values(finalLibs))

        this._processClassPathList(cpArgs)

        return cpArgs
    }

    /**
     * Resolve the libraries defined by Mojang's version data. This method will also extract
     * native libraries and point to the correct location for its classpath.
     * 
     * TODO - clean up function
     * 
     * @param {string} tempNativePath The path to store the native libraries.
     * @returns {{[id: string]: string}} An object containing the paths of each library mojang declares.
     */
    _resolveMojangLibraries(tempNativePath){
        const nativesRegex = /.+:natives-([^-]+)(?:-(.+))?/
        const libs = {}

        const libArr = this.vanillaManifest.libraries
        fs.ensureDirSync(tempNativePath)
        for(let i=0; i<libArr.length; i++){
            const lib = libArr[i]
            if(isLibraryCompatible(lib.rules, lib.natives)){

                // Pre-1.19 has a natives object.
                if(lib.natives != null) {
                    // Extract the native library.
                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/']
                    const artifact = lib.downloads.classifiers[lib.natives[getMojangOS()].replace('${arch}', process.arch.replace('x', ''))]

                    // Location of native zip.
                    const to = path.join(this.libPath, artifact.path)

                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()

                    // Unzip the native zip.
                    for(let i=0; i<zipEntries.length; i++){
                        const fileName = zipEntries[i].entryName

                        let shouldExclude = false

                        // Exclude noted files.
                        exclusionArr.forEach(function(exclusion){
                            if(fileName.indexOf(exclusion) > -1){
                                shouldExclude = true
                            }
                        })

                        // Extract the file.
                        if(!shouldExclude){
                            fs.writeFile(path.join(tempNativePath, fileName), zipEntries[i].getData(), (err) => {
                                if(err){
                                    logger.error('Error while extracting native library:', err)
                                }
                            })
                        }

                    }
                }
                // 1.19+ logic
                else if(lib.name.includes('natives-')) {

                    const regexTest = nativesRegex.exec(lib.name)
                    // const os = regexTest[1]
                    const arch = regexTest[2] ?? 'x64'

                    if(arch != process.arch) {
                        continue
                    }

                    // Extract the native library.
                    const exclusionArr = lib.extract != null ? lib.extract.exclude : ['META-INF/', '.git', '.sha1']
                    const artifact = lib.downloads.artifact

                    // Location of native zip.
                    const to = path.join(this.libPath, artifact.path)

                    let zip = new AdmZip(to)
                    let zipEntries = zip.getEntries()

                    // Unzip the native zip.
                    for(let i=0; i<zipEntries.length; i++){
                        if(zipEntries[i].isDirectory) {
                            continue
                        }

                        const fileName = zipEntries[i].entryName

                        let shouldExclude = false

                        // Exclude noted files.
                        exclusionArr.forEach(function(exclusion){
                            if(fileName.indexOf(exclusion) > -1){
                                shouldExclude = true
                            }
                        })

                        const extractName = fileName.includes('/') ? fileName.substring(fileName.lastIndexOf('/')) : fileName

                        // Extract the file.
                        if(!shouldExclude){
                            fs.writeFile(path.join(tempNativePath, extractName), zipEntries[i].getData(), (err) => {
                                if(err){
                                    logger.error('Error while extracting native library:', err)
                                }
                            })
                        }

                    }
                }
                // No natives
                else {
                    const dlInfo = lib.downloads
                    const artifact = dlInfo.artifact
                    const to = path.join(this.libPath, artifact.path)
                    const versionIndependentId = lib.name.substring(0, lib.name.lastIndexOf(':'))
                    libs[versionIndependentId] = to
                }
            }
        }

        return libs
    }

    /**
     * Resolve the libraries declared by this server in order to add them to the classpath.
     * This method will also check each enabled mod for libraries, as mods are permitted to
     * declare libraries.
     * 
     * @param {Array.<Object>} mods An array of enabled mods which will be launched with this process.
     * @returns {{[id: string]: string}} An object containing the paths of each library this server requires.
     */
    _resolveServerLibraries(mods){
        const mdls = this.server.modules
        let libs = {}

        // Locate Forge/Fabric/Libraries
        for(let mdl of mdls){
            const type = mdl.rawModule.type
            if(type === Type.ForgeHosted || type === Type.Fabric || type === Type.Library){
                libs[mdl.getVersionlessMavenIdentifier()] = mdl.getPath()
                if(mdl.subModules.length > 0){
                    const res = this._resolveModuleLibraries(mdl)
                    libs = {...libs, ...res}
                }
            }
        }

        //Check for any libraries in our mod list.
        for(let i=0; i<mods.length; i++){
            if(mods.sub_modules != null){
                const res = this._resolveModuleLibraries(mods[i])
                libs = {...libs, ...res}
            }
        }

        return libs
    }

    /**
     * Recursively resolve the path of each library required by this module.
     * 
     * @param {Object} mdl A module object from the server distro index.
     * @returns {{[id: string]: string}} An object containing the paths of each library this module requires.
     */
    _resolveModuleLibraries(mdl){
        if(mdl.subModules.length === 0){
            return {}
        }
        let libs = {}
        for(let sm of mdl.subModules){
            if(sm.rawModule.type === Type.Library){

                if(sm.rawModule.classpath ?? true) {
                    libs[sm.getVersionlessMavenIdentifier()] = sm.getPath()
                }
            }
            // If this module has submodules, we need to resolve the libraries for those.
            // To avoid unnecessary recursive calls, base case is checked here.
            if(mdl.subModules.length > 0){
                const res = this._resolveModuleLibraries(sm)
                libs = {...libs, ...res}
            }
        }
        return libs
    }

}

module.exports = ProcessBuilder