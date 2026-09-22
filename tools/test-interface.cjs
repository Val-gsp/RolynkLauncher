/* Browser checks use the production templates, styles and interaction functions. */
const { chromium } = require('playwright')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const ejs = require('ejs')
const Lang = require('../app/assets/js/langloader')
Lang.setupLanguage()
const acorn = require('acorn')
const root = path.resolve(__dirname, '..')
const out = process.env.ROLYNK_UI_ARTIFACTS || fs.mkdtempSync('/tmp/rolynk-interface-')
fs.mkdirSync(out, { recursive: true })
function render(name) {
    return ejs.render(fs.readFileSync(path.join(root, `app/${name}.ejs`), 'utf8'), { lang: Lang.queryEJS }).replace(/<script[\s\S]*?<\/script>/g, '')
}
const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><base href="file://${root}/app/">${['launcher', 'home', 'interface'].map(name => `<link rel="stylesheet" href="assets/css/${name}.css">`).join('')}</head><body style="height:100vh"><div style="height:22px;background:#0b100b"></div><div id="main" style="position:absolute;top:22px;width:100%;height:calc(100vh - 22px)">${render('landing')}${render('settings')}</div></body></html>`
fs.writeFileSync(path.join(out, 'preview.html'), html)
function functions(source, names) {
    return acorn.parse(source, { ecmaVersion: 'latest' }).body.filter(node => node.type === 'FunctionDeclaration' && names.includes(node.id.name)).map(node => source.slice(node.start, node.end)).join('\n')
}
;(async () => {
    const browser = await chromium.launch({ args: ['--no-sandbox'] })
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
        const errors = []
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(require('node:url').pathToFileURL(path.join(out, 'preview.html')).href)
        await page.addScriptTag({ path: path.join(root, 'node_modules/jquery/dist/jquery.js') })
        const metadata = Object.fromEntries(['forest_keeper', 'arctic_witch', 'meowgician'].map(name => [name, require(path.join(root, `app/assets/images/pets/${name}.json`))]))
        await page.evaluate(metadata => {
            window.paintCounts = new Map()
            const drawImage = CanvasRenderingContext2D.prototype.drawImage
            CanvasRenderingContext2D.prototype.drawImage = function(...args) { window.paintCounts.set(this.canvas, (window.paintCounts.get(this.canvas) || 0) + 1); return drawImage.apply(this, args) }
            window.require = name => metadata[name.split('/').pop().replace('.json', '')]
            window.config = { GameWidth: '1280', GameHeight: '720', Fullscreen: false, AutoConnect: true, LaunchDetached: false, MinRAM: '3G', MaxRAM: '6G', JavaExecutable: '/usr/bin/java', JVMOptions: ['-Dexample=true'], AllowPrerelease: false, PotatoMode: false, DataDirectory: '/tmp/minecraft-test' }
            window.ConfigManager = new Proxy({}, { get: (_, key) => key === 'getSelectedServer' ? () => 'v1' : key === 'save' ? () => { window.saved = true } : key.startsWith('get') ? () => window.config[key.slice(3)] : key.startsWith('set') ? (...args) => { window.config[key.slice(3)] = args.at(-1) } : undefined })
            window.server = { rawServer: { id: 'v1', name: 'Rolynk V1', minecraftVersion: '1.21.1' } }
            window.DistroAPI = { getDistribution: async () => ({ servers: [window.server], getServerById: () => window.server }) }
            window.updateSelectedServer = () => {}
            window.refreshServerStatus = () => {}
            window.toggleServerSelection = async () => {}
            window.VIEWS = { landing: '#landingContainer', settings: '#settingsContainer' }
            window.currentView = VIEWS.landing
            window.getCurrentView = () => window.currentView
            window.switchView = (old, next) => { $(old).hide(); $(next).show(); window.currentView = next }
            window.populateJavaExecDetails = async () => {}
            window.changeAllowPrerelease = () => {}
            window.saveModConfiguration = window.saveDropinModConfiguration = window.saveShaderpackSettings = () => {}
            document.querySelector('#landingContainer').style.display = 'flex'
            document.querySelector('#user_text').textContent = 'Beedir'
            document.querySelector('#player_count').textContent = '12 en ligne'
            document.querySelector('#server_selection_button').textContent = 'Rolynk V1'
            // A full-height silhouette makes portrait containment inspectable without a player account.
            document.querySelector('#avatarContainer').style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="64"><path fill="#ba875c" d="M8 0h16v16H8z"/><path fill="#649554" d="M8 16h16v28H8zM0 16h8v26H0zm24 0h8v26h-8z"/><path fill="#5b6588" d="M8 44h7v20H8zm9 0h7v20h-7z"/></svg>')}")`
        }, metadata)
        const landing = fs.readFileSync(path.join(root, 'app/assets/js/scripts/landing.js'), 'utf8')
        const shopStart = landing.indexOf('let shopActive = false')
        const shopEnd = landing.indexOf('/**\n * Legal Panel', shopStart)
        await page.addScriptTag({ content: landing.slice(shopStart, shopEnd) })
        for (const script of ['home', 'pets']) await page.addScriptTag({ path: path.join(root, `app/assets/js/scripts/${script}.js`) })
        const settings = fs.readFileSync(path.join(root, 'app/assets/js/scripts/settings.js'), 'utf8')
        await page.addScriptTag({ content: 'let selectedSettingsTab = "settingsTabAccount";\n' + functions(settings, ['settingsTabScrollListener', 'setupSettingsTabs', 'settingsNavItemListener', 'initSettingsValues', 'saveSettingsValues', 'fullSettingsSave']) + '\nsetupSettingsTabs();document.getElementById("settingsNavDone").onclick=()=>{fullSettingsSave();switchView(getCurrentView(),VIEWS.landing)}' })
        await page.evaluate(() => initSettingsValues())
        await page.waitForFunction(() => document.querySelectorAll('.homePet canvas').length === 3)
        const pixels = () => page.locator('.homePet canvas').evaluateAll(nodes => nodes.map(node => window.paintCounts.get(node)))
        const before = await pixels(); await page.waitForTimeout(350)
        assert((await pixels()).every((value, i) => value !== before[i]), 'all pets animate')
        // Hover plays the pet reaction, click the ultimate; both hand back to idle on their own.
        await page.locator('.homePetCat .homePetHit').hover({ force: true })
        await page.waitForFunction(() => document.querySelector('.homePetCat').classList.contains('isReacting'))
        await page.locator('.homePetForest .homePetHit').click({ force: true })
        await page.waitForFunction(() => document.querySelector('.homePetForest').classList.contains('isUltimate') && document.querySelector('.homeHero').classList.contains('isUltimate'))
        await page.waitForTimeout(1600)
        await page.screenshot({ path: path.join(out, 'home-ultimate.png') })
        await page.waitForFunction(() => !document.querySelector('.homeHero.isUltimate') && !document.querySelector('.homePet.isReacting'), null, { timeout: 8000 })
        for (const [width, height] of [[1280, 800], [980, 552], [800, 552]]) {
            await page.setViewportSize({ width, height })
            await page.evaluate(() => document.querySelector('#homeDashboard').scrollTop = 0)
            const dimensions = await page.evaluate(() => {
                const shop = document.querySelector('#shopButton').getBoundingClientRect()
                const play = document.querySelector('#launch_button').getBoundingClientRect()
                const logo = document.querySelector('#image_seal')
                return { shopY: shop.y, playY: play.y, shopHeight: shop.height, playHeight: play.height, bottom: play.bottom, objectFit: getComputedStyle(logo).objectFit, ratio: logo.naturalWidth / logo.naturalHeight, avatar: getComputedStyle(document.querySelector('#avatarContainer')).backgroundSize, overflow: document.documentElement.scrollWidth > innerWidth }
            })
            await page.screenshot({ path: path.join(out, `home-${width}.png`) })
            assert(Math.abs(dimensions.shopY - dimensions.playY) < 1, 'shop/play top alignment')
            assert.equal(dimensions.shopHeight, dimensions.playHeight)
            assert(dimensions.bottom <= height)
            assert.equal(dimensions.objectFit, 'contain')
            assert(dimensions.ratio > 3)
            assert.equal(dimensions.avatar, 'auto 92%')
            assert.equal(dimensions.overflow, false)
            await page.screenshot({ path: path.join(out, `home-${width}.png`) })
            await page.locator('.homePrimary').click()
            await page.waitForTimeout(420)
            assert(await page.locator('#homeDashboard').evaluate(e => e.inert))
            await page.keyboard.press('Tab')
            assert(await page.locator('#shopContainer').evaluate(e => e.contains(document.activeElement)), 'keyboard navigation remains inside the shop')
            const paused = await pixels(); await page.waitForTimeout(150); assert.deepEqual(await pixels(), paused)
            for (const id of ['commencement', 'intermediaire', 'big', 'prestige']) {
                await page.locator(`[data-pack-id="${id}"]`).scrollIntoViewIfNeeded()
                assert(await page.locator(`[data-pack-id="${id}"]`).isVisible())
            }
            await page.locator('#shopGrid').evaluate(e => e.scrollTop = 0)
            await page.screenshot({ path: path.join(out, `shop-${width}.png`) })
            await page.keyboard.press('Escape')
            await page.waitForTimeout(420)
            assert(await page.locator('.homePrimary').evaluate(e => e === document.activeElement))
            assert(await page.locator('#shopContainer').evaluate(e => e.inert))
        }
        // Reverse an in-progress transition repeatedly without stale animation timers.
        await page.evaluate(() => { toggleShop(); toggleShop(); toggleShop() })
        await page.waitForTimeout(420)
        assert.equal(await page.locator('#shopContainer').evaluate(e => getComputedStyle(e).opacity), '1')
        await page.locator('#shopCloseButton').click()
        await page.waitForTimeout(420)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await page.waitForTimeout(100) // the media change event is delivered asynchronously
        const still = await pixels(); await page.waitForTimeout(150); assert.deepEqual(await pixels(), still)
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        // Every settings tab is reached using its original navigation handler.
        for (const [width, height] of [[1280, 800], [800, 552]]) {
            await page.setViewportSize({ width, height })
            await page.evaluate(() => switchView(VIEWS.landing, VIEWS.settings))
            for (const id of ['Account', 'Minecraft', 'Mods', 'Java', 'Launcher', 'About', 'Update']) {
                await page.locator(`[rSc="settingsTab${id}"]`).click()
                await page.waitForTimeout(550)
                assert(await page.locator(`#settingsTab${id}`).isVisible())
                assert(await page.locator('#settingsNavDone').isVisible())
                assert(await page.locator(`#settingsTab${id}`).evaluate(e => e.scrollWidth <= e.clientWidth + 1), `${id} horizontal overflow at ${width}`)
                await page.screenshot({ path: path.join(out, `settings-${id.toLowerCase()}-${width}.png`) })
            }
        }
        await page.locator('[rSc="settingsTabMinecraft"]').click(); await page.waitForTimeout(550)
        await page.locator('#settingsGameWidth').fill('1600')
        await page.locator('[cValue="Fullscreen"] + .toggleSwitchSlider').click()
        await page.locator('[rSc="settingsTabLauncher"]').click(); await page.waitForTimeout(550)
        await page.locator('[cValue="PotatoMode"] + .toggleSwitchSlider').click()
        await page.locator('#settingsNavDone').click()
        assert.equal(await page.evaluate(() => config.GameWidth), '1600')
        assert.equal(await page.evaluate(() => config.Fullscreen), true)
        assert.equal(await page.evaluate(() => config.PotatoMode), true)
        assert.equal(await page.evaluate(() => window.saved), true)
        assert.equal(await page.evaluate(() => config.JavaExecutable), '/usr/bin/java')
        assert.deepEqual(await page.evaluate(() => config.JVMOptions), ['-Dexample=true'])
        await page.waitForTimeout(100)
        const potato = await pixels(); await page.waitForTimeout(150); assert.deepEqual(await pixels(), potato)
        assert.deepEqual(errors, [])
        console.log(`PASS: logo, full portrait, action alignment, reversible shop transitions, 3 animated pets, pet/ultimate playback and pause modes, 7 settings tabs, save roundtrip. Captures: ${out}`)
    } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
