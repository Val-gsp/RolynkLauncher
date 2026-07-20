// Génère un distribution.json Helios pour NeoForge à partir d'une installation client locale.
// Usage: node gen-distro.js <neoforge-root> <base-url> [adresse-serveur-mc]
// Les mods (.jar) déposés dans <neoforge-root>/mods sont distribués dans le dossier
// mods/ de l'instance de chaque joueur (chargés nativement par NeoForge).
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = process.argv[2]
const BASE = process.argv[3].replace(/\/$/, '')
const MC_ADDRESS = process.argv[4] || '127.0.0.1:25565'

const NEOFORGE_VERSION = '21.1.235'
const MC_VERSION = '1.21.1'
const NEOFORM = '20240808.144430'
const MANIFEST_ID = `neoforge-${NEOFORGE_VERSION}`

function md5(p) {
    return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex')
}

function art(relPosix) {
    const p = path.join(ROOT, ...relPosix.split('/'))
    if (!fs.existsSync(p)) throw new Error('Fichier introuvable: ' + p)
    return {
        size: fs.statSync(p).size,
        MD5: md5(p),
        url: `${BASE}/${relPosix}`
    }
}

const versionJsonRel = `versions/${MANIFEST_ID}/${MANIFEST_ID}.json`
const versionJsonAbs = path.join(ROOT, ...versionJsonRel.split('/'))
const vj = JSON.parse(fs.readFileSync(versionJsonAbs, 'utf8'))

// Helios place l'artefact du module ForgeHosted (l'universal) sur le classpath,
// contrairement au launcher vanilla. Sans exclusion, BootstrapLauncher absorbe
// ses classes dans la couche de bootstrap où les classes du jeu sont invisibles
// (NoClassDefFoundError). On ajoute donc le préfixe "neoforge-" à l'ignoreList,
// exactement comme Forge le fait avec son préfixe "forge-".
vj.arguments.jvm = vj.arguments.jvm.map(arg => {
    if (typeof arg === 'string' && arg.startsWith('-DignoreList=') && !arg.includes('neoforge-')) {
        return arg.replace('-DignoreList=', '-DignoreList=neoforge-,')
    }
    return arg
})
fs.writeFileSync(versionJsonAbs, JSON.stringify(vj, null, 2))

const subModules = []

// Manifeste de version NeoForge (le "mod manifest" lu par le launcher)
subModules.push({
    id: MANIFEST_ID,
    name: 'NeoForge (version.json)',
    type: 'VersionManifest',
    artifact: art(versionJsonRel)
})

// Artefacts générés par l'installeur (requis au runtime, PAS sur le classpath)
subModules.push({
    id: `net.neoforged:neoforge:${NEOFORGE_VERSION}:client`,
    name: 'NeoForge (client patché)',
    type: 'Library',
    classpath: false,
    artifact: art(`libraries/net/neoforged/neoforge/${NEOFORGE_VERSION}/neoforge-${NEOFORGE_VERSION}-client.jar`)
})
subModules.push({
    id: `net.minecraft:client:${MC_VERSION}-${NEOFORM}:extra`,
    name: 'Minecraft (client-extra)',
    type: 'Library',
    classpath: false,
    artifact: art(`libraries/net/minecraft/client/${MC_VERSION}-${NEOFORM}/client-${MC_VERSION}-${NEOFORM}-extra.jar`)
})
// Jar de base du client (classes vanilla remappées) : NeoForge assemble le jeu
// à partir de srg + extra + neoforge-client. Sans lui : ClassNotFoundException.
subModules.push({
    id: `net.minecraft:client:${MC_VERSION}-${NEOFORM}:srg`,
    name: 'Minecraft (client-srg)',
    type: 'Library',
    classpath: false,
    artifact: art(`libraries/net/minecraft/client/${MC_VERSION}-${NEOFORM}/client-${MC_VERSION}-${NEOFORM}-srg.jar`)
})
subModules.push({
    id: `net.minecraft:client:${MC_VERSION}-${NEOFORM}:slim`,
    name: 'Minecraft (client-slim)',
    type: 'Library',
    classpath: false,
    artifact: art(`libraries/net/minecraft/client/${MC_VERSION}-${NEOFORM}/client-${MC_VERSION}-${NEOFORM}-slim.jar`)
})

// Bibliothèques déclarées par le version.json de NeoForge (classpath)
for (const lib of vj.libraries) {
    subModules.push({
        id: lib.name,
        name: lib.name,
        type: 'Library',
        artifact: art('libraries/' + lib.downloads.artifact.path)
    })
}

const mainModule = {
    id: `net.neoforged:neoforge:${NEOFORGE_VERSION}:universal`,
    name: 'NeoForge',
    type: 'ForgeHosted',
    artifact: art(`libraries/net/neoforged/neoforge/${NEOFORGE_VERSION}/neoforge-${NEOFORGE_VERSION}-universal.jar`),
    subModules
}

// Mods : tout .jar dans <ROOT>/mods est distribué dans le dossier mods/ de l'instance.
// Mods : tout .jar dans <ROOT>/<srcDir> est distribué dans le dossier mods/
// de l'instance. Chaque serveur a son propre srcDir (mods/ vs mods_v1/) pour
// que les listes de mods puissent diverger entre les deux instances.
function scanMods(srcDir, idNs) {
    const out = []
    const dir = path.join(ROOT, srcDir)
    if (!fs.existsSync(dir)) return out
    for (const f of fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.jar'))) {
        out.push({
            id: `${idNs}:${f.replace(/\.jar$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_')}:1.0`,
            name: f,
            type: 'File',
            artifact: Object.assign(art(`${srcDir}/${f}`), { path: `mods/${f}` })
        })
    }
    console.log(`${out.length} mods trouvés dans ${dir}`)
    return out
}

// Shaderpacks : tout .zip dans <ROOT>/<srcDir> est distribué dans le dossier
// shaderpacks/ de l'instance (utilisable via Iris, déjà dans le pack client).
function scanShaders(srcDir, idNs) {
    const out = []
    const dir = path.join(ROOT, srcDir)
    if (!fs.existsSync(dir)) return out
    for (const f of fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.zip'))) {
        out.push({
            id: `${idNs}:${f.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_')}:1.0`,
            name: f,
            type: 'File',
            artifact: Object.assign(art(`${srcDir}/${f}`), { path: `shaderpacks/${f}` })
        })
    }
    console.log(`${out.length} shaderpacks trouvés dans ${dir}`)
    return out
}

// Resourcepacks : tout .zip dans <ROOT>/<srcDir> est distribué dans le dossier
// resourcepacks/ de l'instance. Comme pour les mods, aucun champ "required" n'est
// nécessaire : les modules "File" du launcher sont obligatoires par défaut (le
// joueur ne peut pas les désélectionner), exactement comme scanMods ci-dessus.
function scanResourcepacks(srcDir, idNs) {
    const out = []
    const dir = path.join(ROOT, srcDir)
    if (!fs.existsSync(dir)) return out
    for (const f of fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.zip'))) {
        out.push({
            id: `${idNs}:${f.replace(/\.zip$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_')}:1.0`,
            name: f,
            type: 'File',
            artifact: Object.assign(art(`${srcDir}/${f}`), { path: `resourcepacks/${f}` })
        })
    }
    console.log(`${out.length} resourcepacks trouvés dans ${dir}`)
    return out
}

// NeoForge/bibliothèques : identiques pour les deux instances (mêmes URLs,
// donc téléchargées une seule fois côté joueur si déjà en cache).
const javaOptions = { suggestedMajor: 21, supported: '21.x' }

const distro = {
    version: '1.0.0',
    servers: [
        {
            id: 'Rolynk-1.21.1',
            name: 'Rolynk',
            description: 'Serveur Rolynk — Minecraft 1.21.1 NeoForge.',
            icon: `${BASE}/icon.png`,
            version: '1.0.0',
            address: MC_ADDRESS,
            minecraftVersion: MC_VERSION,
            javaOptions,
            mainServer: true,
            autoconnect: true,
            modules: [mainModule, ...scanMods('mods', 'rolynk.mods'), ...scanShaders('shaderpacks', 'rolynk.shaderpacks')]
        },
        {
            id: 'RolynkV1-1.21.1',
            name: 'Rolynk V1',
            description: 'Serveur Rolynk V1 — nouvelle version en préparation. Minecraft 1.21.1 NeoForge.',
            icon: `${BASE}/icon.png`,
            version: '1.0.0',
            address: MC_ADDRESS.replace(/:\d+$/, ':26565'),
            minecraftVersion: MC_VERSION,
            javaOptions,
            mainServer: false,
            autoconnect: true,
            modules: [mainModule, ...scanMods('mods_v1', 'rolynk.v1.mods'), ...scanShaders('shaderpacks_v1', 'rolynk.v1.shaderpacks'), ...scanResourcepacks('resourcepacks_v1', 'rolynk.v1.resourcepacks')]
        }
    ]
}

fs.writeFileSync(path.join(ROOT, 'distribution.json'), JSON.stringify(distro, null, 2))
console.log(`distribution.json généré: ${distro.servers.length} serveurs, ${vj.libraries.length} bibliothèques partagées`)
