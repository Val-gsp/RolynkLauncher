// Bake every shop pet to a looping single-row sprite strip (webp).
//
//   npm install --no-save three
//   npx electron tools/render-shop-pets.cjs <packs-dir> <cubees-dir> [output-dir]
//
// <packs-dir> holds the unzipped resource packs served to players: dogs/ (Better_Dogs),
// cats/ (Better_Cats) and cerb/ (RolynkRP_CerberusColoris). <cubees-dir> holds the
// cubee-*.bbmodel files from the rolynkrp-pets jar. Electron is the WebGL renderer.
//
// Dogs and cats are vanilla wolves and cats reskinned by those OptiFine CEM packs: the breed
// is picked from the pet's name (the mod names each pet with its breed keyword), and the
// breed texture only paints that breed's parts of the shared model. The model is rebuilt the
// way Blockbench imports .jem files, then posed with the vanilla walk plus the pack's own
// animation expressions. Cubees play their original Blockbench idle animation, and their
// ultimate is also baked (<id>-effect.webp, effects.json) for the shop's "see the effect" preview.
const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')

const [packs, cubees, outArg] = process.argv.slice(2).filter(a => !a.startsWith('-'))
if (!packs || !cubees) {
    console.error('Usage: npx electron tools/render-shop-pets.cjs <packs-dir> <cubees-dir> [output-dir]')
    process.exit(1)
}
const output = path.resolve(outArg || path.join(__dirname, '../app/assets/images/pets/shop'))
const TILE = 160
// The Forest Keeper's ultimate grows a tree several times its size: frame it wider.
const EFFECT_REACH = { forest_keeper: 3.6 }
// Legendaries are shown bigger in the shop; 200 px keeps the longest strip under WebP's 16383 px.
const LEGENDARY = new Set(['cerberus_0', 'cerberus_1', 'cerberus_2', 'wither', 'arctic_witch', 'forest_keeper', 'meowgician'])

// Shop pet id -> [model, name the mod gives the pet]. Cerberus coloris are named Cerberusa/b/c.
const PETS = {
    chihuahua: ['dog', 'chihuahua'], pug: ['dog', 'pug'], dachshund: ['dog', 'teckel'], beagle: ['dog', 'beagle'],
    pomeranian: ['dog', 'pomeranian'], corgi: ['dog', 'corgi'], poodle: ['dog', 'poodle'], border_collie: ['dog', 'border collie'],
    labrador: ['dog', 'labrador'], bulldog: ['dog', 'bulldog'], dalmatian: ['dog', 'dalmatian'], husky: ['dog', 'husky'],
    boxer: ['dog', 'boxer'], golden_retriever: ['dog', 'golden retriever'], samoyed: ['dog', 'samoyed'], shiba_inu: ['dog', 'shiba inu'],
    german_shepherd: ['dog', 'german shepherd'], saint_bernard: ['dog', 'bernard'], rottweiler: ['dog', 'rottweiler'],
    doberman: ['dog', 'doberman'], great_dane: ['dog', 'great dane'], skeleton: ['dog', 'skeleton'], astronaut: ['dog', 'astronaut'],
    cerberus_0: ['dog', 'Cerberusa'], cerberus_1: ['dog', 'Cerberusb'], cerberus_2: ['dog', 'Cerberusc'], wither: ['dog', 'wither'],
    tabby: ['cat', 'tabby'], ginger: ['cat', 'ginger'], tuxedo: ['cat', 'tuxedo'], calico: ['cat', 'calico'], jellie: ['cat', 'jellie'],
    siamese: ['cat', 'siamese'], siberian: ['cat', 'siberian'], somali: ['cat', 'somali'], russian_blue: ['cat', 'russian blue'],
    persian: ['cat', 'persian'], ragdoll: ['cat', 'ragdoll'], lykoi: ['cat', 'lykoi'], savannah: ['cat', 'savannah cat'], sphynx: ['cat', 'sphynx'],
    wishing_teddy: ['cubee'], arctic_witch: ['cubee'], forest_keeper: ['cubee'], meowgician: ['cubee']
}
const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',')
const debug = process.argv.find(a => a.startsWith('--pose='))?.slice(7).split(',') || []

const optifine = pack => path.join(packs, pack, 'assets/minecraft/optifine')
const MODELS = {
    dog: { jem: path.join(optifine('dogs'), 'cem/wolf.jem'), textures: path.join(optifine('dogs'), 'mob/wolf'), base: 'wolf_tame', rules: path.join(optifine('cerb'), 'mob/wolf/wolf_tame.properties') },
    cat: { jem: path.join(optifine('cats'), 'cem/cat.jem'), textures: path.join(optifine('cats'), 'mob/cat'), base: 'tabby', rules: path.join(optifine('cats'), 'mob/cat/tabby.properties') }
}

// Some pack files carry raw control characters inside strings.
// eslint-disable-next-line no-control-regex
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/[\u0000-\u001f]/g, ' '))

// OptiFine random-entity rules: the first rule whose name regex matches picks the skin.
function skinFor(rulesFile, name) {
    const rules = {}
    for (const line of fs.readFileSync(rulesFile, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^(skins|name)\.(\d+)=(.*)$/)
        if (m) (rules[m[2]] = rules[m[2]] || {})[m[1]] = m[3].trim()
    }
    const hit = Object.entries(rules).sort((a, b) => a[0] - b[0])
        .find(([, r]) => r.name && r.skins && new RegExp(`^${r.name.replace(/^iregex:/, '')}$`, 'i').test(name))
    if (!hit) throw new Error(`No skin rule matches "${name}" in ${rulesFile}`)
    // Skin 1 is the plain vanilla texture; prefer a breed-specific one when the rule offers it.
    const skins = hit[1].skins.split(/\s+/).map(Number)
    return skins.find(s => s !== 1) ?? 1
}

// Blockbench box UV, with sizes floored as in Blockbench's optifine_entity format.
function boxFaces(from, to, [u, v], mirror) {
    const [w, h, d] = [0, 1, 2].map(i => Math.floor(to[i] - from[i] + 1e-7))
    const list = {
        east: [[0, d], [d, h]], west: [[d + w, d], [d, h]], up: [[d + w, d], [-w, -d]],
        down: [[d + w * 2, 0], [-w, d]], south: [[d * 2 + w, d], [w, h]], north: [[d, d], [w, h]]
    }
    if (mirror) {
        for (const f of Object.values(list)) { f[0][0] += f[1][0]; f[1][0] *= -1 }
        [list.east, list.west] = [list.west, list.east]
    }
    return Object.fromEntries(Object.entries(list).map(([face, [[fx, fy], [sx, sy]]]) => [face, [u + fx, v + fy, u + fx + sx, v + fy + sy]]))
}

// Mirrors Blockbench's .jem importer: root origins are negated translates, depth-0 submodel
// origins are absolute, deeper ones are offset by their parent, and boxes by their group.
// `depth` (-1 for roots) tells the renderer how animated translations map back to origins.
function jemTree(jem) {
    const roots = []
    const read = (sub, group, depth) => {
        for (const box of sub.boxes || []) {
            const c = box.coordinates
            const from = [c[0], c[1], c[2]], to = [c[0] + c[3], c[1] + c[4], c[2] + c[5]]
            if (!group.root) for (let i = 0; i < 3; i++) { from[i] += group.origin[i]; to[i] += group.origin[i] }
            const faces = box.textureOffset ? boxFaces(from, to, box.textureOffset, group.mirror)
                : Object.fromEntries(['North', 'East', 'South', 'West', 'Up', 'Down'].filter(f => box['uv' + f]).map(f => [f.toLowerCase(), box['uv' + f]]))
            group.cubes.push({ from, to, inflate: box.sizeAdd || 0, faces })
        }
        for (const s of sub.submodels || []) {
            if (depth >= 1 && s.translate) s.translate = s.translate.map((v, i) => v + group.origin[i])
            const child = { id: s.id || '', depth, origin: s.translate || (depth >= 1 ? sub.translate : null) || [0, 0, 0], rotation: s.rotate || [0, 0, 0], mirror: /u/.test(s.mirrorTexture || ''), cubes: [], children: [], animations: s.animations || [] }
            group.children.push(child)
            read(s, child, depth + 1)
        }
    }
    for (const b of structuredClone(jem.models)) {
        const group = { id: b.part, root: true, depth: -1, origin: (b.translate || [0, 0, 0]).map(v => -v), rotation: b.rotate || [0, 0, 0], mirror: /u/.test(b.mirrorTexture || ''), cubes: [], children: [], animations: b.animations || [] }
        read(b, group, 0)
        roots.push(group)
    }
    return { textureSize: jem.textureSize, roots }
}

const dataUrl = file => 'data:image/png;base64,' + fs.readFileSync(file).toString('base64')

function job(id) {
    const [kind, name] = PETS[id]
    if (kind === 'cubee') {
        const model = JSON.parse(fs.readFileSync(path.join(cubees, `cubee-${id}.bbmodel`), 'utf8'))
        return { id, kind, model }
    }
    const m = MODELS[kind]
    const skin = skinFor(m.rules, name)
    return { id, kind, skin, tree: jemTree(readJson(m.jem)), texture: dataUrl(path.join(m.textures, `${m.base}${skin}.png`)) }
}

app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 400, height: 400, webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true } })
    await win.loadFile(path.join(__dirname, 'render-shop-pets.html'))
    const three = pathToFileURL(path.join(__dirname, '../node_modules/three/build/three.module.js')).href
    fs.mkdirSync(output, { recursive: true })
    const ids = only || Object.keys(PETS)
    const bake = async (id, options, file) => {
        const result = await win.webContents.executeJavaScript(`bake(${JSON.stringify({ three, debug, ...job(id), ...options })})`)
        fs.writeFileSync(path.join(output, `${file}.webp`), Buffer.from(result.strip.split(',')[1], 'base64'))
        console.log('Rendered', file, JSON.stringify(result.meta))
        return result
    }
    const saveMeta = (name, meta) => {
        const metaFile = path.join(output, name)
        const previous = only && fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {}
        fs.writeFileSync(metaFile, JSON.stringify({ ...previous, ...meta }, null, 1))
    }
    try {
        const shop = {}
        for (const id of ids) {
            shop[id] = (await bake(id, { tile: LEGENDARY.has(id) ? 200 : TILE }, id)).meta
        }
        saveMeta('shop.json', shop)
        // Cubee ultimates, with their aura and unlit VFX, for the shop's effect preview.
        const effects = {}
        for (const id of ids.filter(id => PETS[id][0] === 'cubee')) {
            effects[id] = (await bake(id, { tile: 320, anim: 'ultimate', fps: 15, reach: EFFECT_REACH[id] }, `${id}-effect`)).meta
        }
        saveMeta('effects.json', effects)
    } catch (err) {
        console.error(err)
        process.exitCode = 1
    }
    app.quit()
})
