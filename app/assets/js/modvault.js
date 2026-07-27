/**
 * ModVault
 *
 * Coffre local chiffré pour le contenu privé du modpack (mods, en pratique
 * n'importe quel fichier "File" sensible déclaré par la distribution). Les
 * fichiers ne sont JAMAIS conservés en clair entre deux lancements : ils sont
 * stockés ici sous forme de blobs chiffrés (AES-256-GCM), nommés d'après leur
 * empreinte, et ne sont déchiffrés que juste avant le lancement du jeu, dans
 * un répertoire éphémère qui est effacé de façon sécurisée dès la fermeture
 * de Minecraft (voir processbuilder.js).
 *
 * Ce module ne remplace pas une vraie protection serveur : si les URLs de
 * téléchargement restent publiques et non authentifiées, ce coffre ne protège
 * que la copie locale du joueur, pas la distribution en amont. Voir
 * protection_mods_launcher.md, section "Ce qui reste récupérable".
 *
 * @module modvault
 */
const crypto = require('crypto')
const fs      = require('fs-extra')
const os      = require('os')
const path    = require('path')
const { LoggerUtil } = require('helios-core')

const ConfigManager = require('./configmanager')

// Nom de logger volontairement neutre : on évite "vault"/"drm"/"crypt" dans
// les chaînes qui finissent en clair dans les logs et dans l'asar.
const logger = LoggerUtil.getLogger('Cache')

function getSafeStorage(){
    try {
        return require('@electron/remote').safeStorage
    } catch (err) {
        return null
    }
}

// --- Emplacement du coffre ---
//
// Le nom du dossier est dérivé du deviceId (déjà généré par ConfigManager
// pour l'auth Rolynk) plutôt que d'être une chaîne fixe du type "modvault".
// Deux intérêts : (1) grep-er l'asar ne donne pas le nom réel du dossier
// présent sur le disque des joueurs, (2) le nom diffère d'une machine à
// l'autre, donc on ne peut pas indexer/cibler "le dossier Rolynk" en masse.

function vaultDirName(){
    const seed = ConfigManager.getDeviceId()
    return '.rt-' + crypto.createHash('sha256').update(seed).digest('hex').slice(0, 12)
}

function getVaultRoot(){
    const root = path.join(ConfigManager.getDataDirectory(), vaultDirName())
    fs.ensureDirSync(path.join(root, 'objects'))
    return root
}

// --- Clé de coffre ---
//
// Générée aléatoirement au premier lancement, puis scellée avec safeStorage
// (DPAPI sur Windows, Keychain sur macOS, libsecret sur Linux) exactement
// comme les jetons de compte dans configmanager.js/rolynkauth.js. La clé en
// clair ne quitte jamais la mémoire du processus ; ce qui est stocké sur
// disque (dans config.json, via ConfigManager) est un blob DPAPI illisible
// ailleurs que sur ce compte Windows et cette machine.
//
// Conséquence directe : copier le dossier du coffre + config.json sur une
// autre machine ne suffit pas à déchiffrer quoi que ce soit.

let cachedKey = null

function loadOrCreateVaultKey(){
    if(cachedKey != null){
        return cachedKey
    }
    const sealed = ConfigManager.getVaultKeySeal()
    const ss = getSafeStorage()
    if(sealed != null){
        if(sealed.enc){
            if(!ss || !ss.isEncryptionAvailable()){
                throw new Error('Coffre local verrouillé sur cette machine (stockage sécurisé indisponible).')
            }
            cachedKey = Buffer.from(ss.decryptString(Buffer.from(sealed.v, 'base64')), 'base64')
            return cachedKey
        }
        cachedKey = Buffer.from(sealed.v, 'base64')
        return cachedKey
    }
    const fresh = crypto.randomBytes(32)
    if(ss && ss.isEncryptionAvailable()){
        ConfigManager.setVaultKeySeal({ enc: true, v: ss.encryptString(fresh.toString('base64')).toString('base64') })
    } else {
        logger.warn('Stockage sécurisé indisponible : clé de coffre non liée à la machine.')
        ConfigManager.setVaultKeySeal({ enc: false, v: fresh.toString('base64') })
    }
    ConfigManager.save()
    cachedKey = fresh
    return cachedKey
}

// --- Primitives de chiffrement ---
//
// Format d'un blob sur disque : [iv(12)][authTag(16)][ciphertext...]
// AES-256-GCM authentifie le contenu : toute altération du blob (corruption,
// modification) fait échouer le déchiffrement au lieu de produire un jar
// corrompu silencieusement chargé par la JVM.

function encryptBuffer(key, plaintext){
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, ct])
}

function decryptBuffer(key, blob){
    const iv = blob.subarray(0, 12)
    const tag = blob.subarray(12, 28)
    const ct = blob.subarray(28)
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()])
}

function sha256Hex(buf){
    return crypto.createHash('sha256').update(buf).digest('hex')
}

// --- Index chiffré (remplace un manifeste JSON en clair) ---
//
// Associe un identifiant opaque (vaultId, dérivé par HMAC, jamais le nom réel
// du mod) à l'emplacement de son blob et à l'empreinte du contenu déchiffré.
// L'index entier est chiffré avec la clé de coffre : même en cas de fuite du
// dossier complet, la correspondance blob -> mod n'est pas lisible sans la
// clé (qui elle-même ne quitte jamais la machine, cf. ci-dessus).

function manifestPath(root){
    return path.join(root, 'index.dat')
}

function loadManifest(root, key){
    const p = manifestPath(root)
    if(!fs.existsSync(p)){
        return {}
    }
    try {
        return JSON.parse(decryptBuffer(key, fs.readFileSync(p)).toString('utf8'))
    } catch (err) {
        logger.error('Index de coffre illisible, réinitialisation.', err)
        return {}
    }
}

function saveManifest(root, key, manifest){
    fs.writeFileSync(manifestPath(root), encryptBuffer(key, Buffer.from(JSON.stringify(manifest), 'utf8')))
}

/**
 * Dérive l'identifiant opaque utilisé comme clé d'index pour un identifiant
 * de module donné (typiquement `mdl.getVersionlessMavenIdentifier()` ou tout
 * autre identifiant stable déclaré par la distribution). Le résultat ne
 * permet pas de retrouver l'identifiant d'origine.
 *
 * @param {string} moduleIdentifier Identifiant stable du module dans la distribution.
 * @returns {string} Identifiant opaque (hex).
 */
exports.vaultIdFor = function(moduleIdentifier){
    return crypto.createHmac('sha256', ConfigManager.getDeviceId()).update(moduleIdentifier).digest('hex')
}

/**
 * Vérifie si le coffre possède déjà une entrée à jour pour cet identifiant
 * (même empreinte de contenu déchiffré). Sert à éviter de re-sceller un mod
 * qui n'a pas changé depuis le dernier lancement.
 *
 * @param {string} vaultId Voir vaultIdFor.
 * @param {string} expectedSha256 Empreinte SHA-256 attendue du contenu en clair.
 * @returns {boolean}
 */
exports.hasCurrentEntry = function(vaultId, expectedSha256){
    const root = getVaultRoot()
    const key = loadOrCreateVaultKey()
    const manifest = loadManifest(root, key)
    return manifest[vaultId] != null && manifest[vaultId].sha256 === expectedSha256
}

/**
 * Chiffre un contenu et l'ajoute (ou remplace) au coffre. Le nom du blob sur
 * disque est dérivé du ciphertext, jamais du contenu en clair ni de
 * l'identifiant du mod.
 *
 * @param {string} vaultId Voir vaultIdFor.
 * @param {Buffer} plaintext Contenu réel du fichier (ex. octets du .jar).
 * @param {string} [expectedSha256] Si fourni, l'empreinte du contenu est vérifiée avant scellement.
 * @returns {{blob: string, sha256: string, size: number}} L'entrée d'index créée.
 */
exports.sealBuffer = function(vaultId, plaintext, expectedSha256){
    const actual = sha256Hex(plaintext)
    if(expectedSha256 != null && actual !== expectedSha256){
        throw new Error(`Empreinte invalide pour l'entrée ${vaultId} (attendu ${expectedSha256}, obtenu ${actual}).`)
    }
    const root = getVaultRoot()
    const key = loadOrCreateVaultKey()
    const manifest = loadManifest(root, key)

    // Purge l'ancien blob si l'entrée est remplacée par un contenu différent.
    const previous = manifest[vaultId]
    if(previous != null && previous.blob != null){
        exports.shred(path.join(root, previous.blob))
    }

    const blob = encryptBuffer(key, plaintext)
    const blobHash = sha256Hex(blob)
    const rel = path.join('objects', blobHash.slice(0, 2), blobHash.slice(2, 4), blobHash + '.bin')
    const dest = path.join(root, rel)
    fs.ensureDirSync(path.dirname(dest))
    fs.writeFileSync(dest, blob, { mode: 0o600 })

    manifest[vaultId] = { blob: rel, sha256: actual, size: plaintext.length, sealedAt: Date.now() }
    saveManifest(root, key, manifest)
    return manifest[vaultId]
}

/**
 * Déchiffre un ensemble d'entrées du coffre dans un répertoire de travail
 * éphémère, à noms de fichiers non explicites (aléatoires, pas le nom réel
 * du mod). Le répertoire doit être détruit via `cleanup()` dès que le
 * processus du jeu se termine (voir processbuilder.js).
 *
 * @param {Array.<{vaultId: string, fileName?: string}>} entries Entrées à matérialiser.
 * L'option fileName force le nom de fichier de sortie (utile quand le loader
 * a besoin d'un nom particulier) ; à défaut un nom aléatoire est utilisé.
 * @param {string} workDir Répertoire de destination (déjà créé par l'appelant).
 * @returns {{[vaultId: string]: string}} Chemins absolus déchiffrés, indexés par vaultId.
 */
exports.unsealInto = function(entries, workDir){
    const root = getVaultRoot()
    const key = loadOrCreateVaultKey()
    const manifest = loadManifest(root, key)
    const resolved = {}

    for(const entry of entries){
        const meta = manifest[entry.vaultId]
        if(meta == null){
            throw new Error('Entrée de coffre manquante (contenu jamais synchronisé ou coffre corrompu).')
        }
        const blob = fs.readFileSync(path.join(root, meta.blob))
        const plaintext = decryptBuffer(key, blob)
        if(sha256Hex(plaintext) !== meta.sha256){
            throw new Error('Intégrité invalide au déchiffrement (blob corrompu ou altéré).')
        }
        const outName = entry.fileName || (crypto.randomBytes(8).toString('hex') + '.jar')
        const outPath = path.join(workDir, outName)
        fs.writeFileSync(outPath, plaintext, { mode: 0o600 })
        resolved[entry.vaultId] = outPath
    }

    return resolved
}

/**
 * Efface un fichier ou un répertoire de façon plus robuste qu'un simple
 * `unlink` : le contenu est écrasé avec des octets aléatoires avant d'être
 * supprimé, afin de limiter la récupération par undelete/carving sur des
 * disques mécaniques ou des systèmes de fichiers qui ne réutilisent pas
 * immédiatement les blocs libérés. Sur SSD avec TRIM ce n'est qu'une
 * défense en profondeur : la garantie réelle vient de la fenêtre
 * d'exposition réduite (le fichier n'a existé que le temps de la partie),
 * pas de l'écrasement lui-même.
 *
 * @param {string} target Fichier ou répertoire à effacer.
 */
exports.shred = function(target){
    try {
        if(!fs.existsSync(target)){
            return
        }
        const stat = fs.statSync(target)
        if(stat.isDirectory()){
            for(const f of fs.readdirSync(target)){
                exports.shred(path.join(target, f))
            }
            fs.rmdirSync(target)
            return
        }
        const size = stat.size
        if(size > 0){
            const fd = fs.openSync(target, 'r+')
            try {
                fs.writeSync(fd, crypto.randomBytes(size), 0, size, 0)
                fs.fsyncSync(fd)
            } finally {
                fs.closeSync(fd)
            }
        }
        fs.unlinkSync(target)
    } catch (err) {
        logger.warn('Effacement sécurisé partiel (le fichier a peut-être déjà été supprimé).', err)
    }
}

/**
 * Crée un répertoire de travail éphémère pour une session de jeu, avec des
 * permissions restreintes au propriétaire quand la plateforme le permet.
 *
 * @returns {string} Chemin absolu du répertoire créé.
 */
exports.createEphemeralWorkDir = function(){
    const workDir = path.join(os.tmpdir(), ConfigManager.getTempNativeFolder(), '.rt-' + crypto.randomBytes(8).toString('hex'))
    fs.ensureDirSync(workDir)
    if(process.platform !== 'win32'){
        try {
            fs.chmodSync(workDir, 0o700)
        } catch (_err) {
            // Best effort : certains systèmes de fichiers réseau/partagés refusent chmod.
        }
    }
    return workDir
}
