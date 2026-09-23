'use strict'
// Run with Electron. Isolated profile; no protocol registration or player accounts.
const electron = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rolynk-startup-test-'))
electron.app.setPath('userData', profile)
const temporary = path.join(profile, 'tmp')
fs.mkdirSync(temporary)
process.env.TEMP = temporary
process.env.TMP = temporary
fs.writeFileSync(path.join(profile, 'config.json'), JSON.stringify({settings:{launcher:{dataDirectory:path.join(profile,'data')}}}))
const signedFixture = process.argv[2]
if (signedFixture) fs.copyFileSync(signedFixture, path.join(profile, 'distribution.json'))
electron.app.setAsDefaultProtocolClient = () => true
electron.app.requestSingleInstanceLock = () => true
const Module = require('module')
const originalLoad = Module._load
class HiddenWindow extends electron.BrowserWindow {
    constructor(options) { super({...options, show:false}) }
}
Module._load = function(id, ...args) {
    if (id === 'electron') return {...electron, BrowserWindow:HiddenWindow}
    return originalLoad.call(this, id, ...args)
}
const errors = []
process.on('uncaughtException', err => { console.error(err.stack); electron.app.exit(1) })
electron.app.on('web-contents-created', (_, contents) => {
    contents.on('console-message', (_, level, message) => {
        if (String(message).includes('Uncaught') || String(message).includes('Unable to load preload')) errors.push(message)
    })
    contents.once('did-finish-load', () => {
        setTimeout(async () => {
            try {
                const state = await contents.executeJavaScript(`({
                    loaded: typeof ConfigManager !== 'undefined' && typeof consumeVerifiedPendingCheckout === 'function',
                    overlay: document.getElementById('overlayTitle')?.textContent,
                    sanitizer: require('./assets/js/security').sanitizeHtml('<img src=x onerror=alert(1)><b>OK</b>'),
                    accountCount: Object.keys(ConfigManager.getAuthAccounts()).length,
                    fatalStartupError
                })`)
                if (!state.loaded || state.accountCount !== 0 || state.sanitizer !== '<b>OK</b>' || errors.length || (signedFixture && state.fatalStartupError)) throw new Error(JSON.stringify({state,errors}))
                console.log(JSON.stringify({electron:process.versions.electron, ...state, errors}))
                electron.app.exit(0)
            } catch (err) { console.error(err.stack); electron.app.exit(1) }
        }, 15000)
    })
})
setTimeout(() => { console.error('Startup test timeout'); electron.app.exit(1) }, 35000)
require('../index')
