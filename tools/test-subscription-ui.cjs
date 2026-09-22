/* global window, document, ui, calls -- callbacks executed inside Chromium */
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const artifacts = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rolynk-subscription-ui-'))
const ejs = require(root + '/node_modules/ejs')
const toml = require(root + '/node_modules/toml')
const strings = toml.parse(fs.readFileSync(root + '/app/assets/lang/fr_FR.toml', 'utf8'))
const template = fs.readFileSync(root + '/app/landing.ejs', 'utf8')
const shop = template.slice(template.indexOf('    <div id="shopContainer"'), template.indexOf('    <div id="legalContainer">'))
const markup = ejs.render(shop.replace(' inert aria-hidden="true"', ''), { lang: key => key.split('.').reduce((o, k) => o[k], strings.ejs) })
fs.writeFileSync(path.join(artifacts, 'preview.html'), `<html><head><meta charset="utf-8"><base href="file://${root}/app/"><link rel="stylesheet" href="assets/css/launcher.css"><link rel="stylesheet" href="assets/css/home.css"><link rel="stylesheet" href="assets/css/interface.css"><style>body{background:radial-gradient(ellipse at top,#203b37,#0b1118);height:100vh}#shopContainer{top:0}</style></head><body><div id="landingContainer" class="shopOpen" style="height:100vh">${markup}</div></body></html>`)
;(async () => {
    const browser = await chromium.launch({ args: ['--no-sandbox'] })
    const page = await browser.newPage({ viewport: { width: 980, height: 552 } })
    await page.goto(require('node:url').pathToFileURL(path.join(artifacts, 'preview.html')).href)
    await page.evaluate(s => {
        window.module = { exports: {} }
        window.messages = s
        window.selected = { type: 'microsoft', uuid: 'player-a' }
        window.plan = { status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: 1790000000 }
        window.calls = []
        window.fail = false
    }, strings.js.landing.subscription)
    await page.addScriptTag({ path: root + '/app/assets/js/shopsubscription.js' })
    await page.evaluate(() => {
        window.ui = new module.exports({ document, window,
            getAccount: () => window.selected,
            getHeaders: a => ({ 'X-Account-UUID': a.uuid }),
            apiBase: 'https://shop.example.test',
            lang: (key, vars = {}) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, v), window.messages[key]),
            fetch: async (url, options) => {
                window.calls.push({ url, method: options.method, uuid: options.headers['X-Account-UUID'] })
                if (window.fail) throw new Error('offline')
                if (options.method === 'POST') window.plan = { ...window.plan, cancelAtPeriodEnd: true }
                return { ok: true, json: async () => ({ subscription: window.plan }) }
            }
        })
    })
    await page.evaluate(() => window.ui.refresh())
    assert.equal(await page.locator('#shopSubscriptionLabel').textContent(), 'En cours')
    assert.equal(await page.locator('[data-pack-id="prestige"]').isVisible(), false)
    await page.locator('#shopSubscriptionMore').click()
    await page.screenshot({ path: path.join(artifacts, 'active-menu.png') })
    await page.locator('#shopSubscriptionCancel').click()
    assert.equal(await page.locator('#shopSubscriptionDialog').evaluate(e => e.open), true)
    assert.equal(await page.evaluate(() => calls.filter(c => c.method === 'POST').length), 0)
    await page.screenshot({ path: path.join(artifacts, 'confirm.png') })
    await page.locator('#shopSubscriptionKeep').click()
    assert.equal(await page.evaluate(() => calls.filter(c => c.method === 'POST').length), 0)
    await page.locator('#shopSubscriptionMore').click()
    await page.locator('#shopSubscriptionCancel').click()
    await page.evaluate(() => { window.fail = true })
    await page.locator('#shopSubscriptionConfirm').click()
    await page.waitForFunction(() => document.querySelector('#shopSubscriptionError').textContent.length > 0)
    assert.equal(await page.locator('#shopSubscriptionDialog').evaluate(e => e.open), true)
    assert.equal(await page.locator('#shopSubscriptionLabel').textContent(), 'En cours')
    await page.evaluate(() => { window.fail = false })
    await page.locator('#shopSubscriptionConfirm').click()
    await page.waitForFunction(() => !document.querySelector('#shopSubscriptionDialog').open)
    assert.equal(await page.locator('#shopSubscriptionLabel').textContent(), 'Résiliation prévue')
    assert.equal(await page.locator('#shopSubscriptionMore').isVisible(), false)
    assert.equal(await page.evaluate(() => calls.filter(c => c.method === 'POST').length), 2)
    await page.evaluate(() => { window.plan = null; return ui.refresh() })
    assert.equal(await page.evaluate(() => ui.canSubscribe()), true)
    assert.equal(await page.locator('[data-pack-id="prestige"]').textContent(), "S'ABONNER")
    await page.evaluate(() => { window.fail = true; return ui.refresh() })
    assert.equal(await page.locator('[data-pack-id="prestige"]').textContent(), 'Réessayer')
    assert.equal(await page.evaluate(() => ui.canSubscribe()), false)
    // Ignore a slow response belonging to a previous selected account.
    await page.evaluate(async () => {
        ui.open = true
        let release
        let count = 0
        ui.fetch = async () => {
            const call = ++count
            if (call === 1) await new Promise(resolve => { release = resolve })
            return { ok: true, json: async () => ({ subscription: call === 1 ? { status: 'active', cancelAtPeriodEnd: false } : null }) }
        }
        const old = ui.refresh()
        window.selected = { type: 'microsoft', uuid: 'player-b' }
        document.dispatchEvent(new Event('shop-account-changed'))
        release()
        await old
    })
    assert.equal(await page.evaluate(() => ui.subscription), null)
    // Compact and two-column layouts: management controls can be scrolled into view.
    for (const width of [980, 800]) {
        await page.setViewportSize({ width, height: 552 })
        await page.evaluate(() => {
            ui.subscription = { status: 'active', cancelAtPeriodEnd: false }
            ui.state = 'ready'; ui.setMenu(false); ui.render()
        })
        await page.locator('#shopSubscriptionMore').scrollIntoViewIfNeeded()
        assert(await page.locator('#shopSubscriptionMore').isVisible())
        await page.locator('#shopSubscriptionMore').click()
        assert(await page.locator('#shopSubscriptionCancel').isVisible())
        assert(await page.locator('#shopSubscriptionCancel').evaluate(e => {
            const r = e.getBoundingClientRect(); const grid = document.querySelector('#shopGrid').getBoundingClientRect()
            return r.top >= grid.top && r.bottom <= grid.bottom
        }))
    }
    console.log('PASS: active state, menu, confirmation, keep, cancellation, non-subscriber, failure, account switch, compact layouts')
    await browser.close()
})().catch(error => { console.error(error); process.exit(1) })
