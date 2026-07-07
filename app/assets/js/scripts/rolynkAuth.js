/**
 * Rolynk Auth view controller (comptes crack).
 * Utilise les fonctions globales définies dans uicore/uibinder/landing
 * (switchView, VIEWS, getCurrentView, updateSelectedAccount, Lang, ConfigManager).
 */
const RolynkAuth = require('./assets/js/rolynkauth')
const { DISCORD_OPCODE, DISCORD_REPLY_TYPE } = require('./assets/js/ipcconstants')

// État transitoire du flux d'authentification.
let rkPendingCreds = null      // {username, password} pour l'auto-login post-Discord
let rkDiscordUrl = null        // URL OAuth reçue à l'inscription
let rk2faChallenge = null      // challenge_id de la 2FA en cours

// --- Utilitaires UI ---

function rkShowPanel(id){
    for(const p of ['rolynkLoginPanel','rolynkRegisterPanel','rolynkDiscordPanel','rolynk2faPanel']){
        document.getElementById(p).style.display = (p === id) ? 'flex' : 'none'
    }
    document.querySelectorAll('.rkError').forEach(e => e.classList.remove('rkShow'))
}

function rkError(spanId, code){
    const el = document.getElementById(spanId)
    el.innerHTML = rkErrorMessage(code)
    el.classList.add('rkShow')
}

function rkErrorMessage(code){
    const msg = Lang.queryJS(`rolynk.err.${code}`)
    return (msg && msg.length > 0) ? msg : Lang.queryJS('rolynk.err.generic')
}

function rkBusy(btn, busy){
    btn.disabled = busy
    btn.dataset.label = btn.dataset.label || btn.textContent
    btn.textContent = busy ? '…' : btn.dataset.label
}

// Finalise une authentification réussie : persiste le compte et va au launcher.
function rkOnAuthSuccess(data){
    const account = RolynkAuth.persistAccount(data)
    if(typeof updateSelectedAccount === 'function'){
        updateSelectedAccount(account)
    }
    const dest = (typeof loginOptionsViewOnLoginSuccess !== 'undefined' && loginOptionsViewOnLoginSuccess)
        ? loginOptionsViewOnLoginSuccess : VIEWS.landing
    rkResetFields()
    switchView(getCurrentView(), dest)
}

function rkResetFields(){
    for(const id of ['rolynkLoginUser','rolynkLoginPass','rolynkRegUser','rolynkRegPass','rolynkRegPass2','rolynk2faCode']){
        const el = document.getElementById(id)
        if(el) el.value = ''
    }
    rkPendingCreds = null
    rkDiscordUrl = null
    rk2faChallenge = null
}

// --- Connexion ---

document.getElementById('rolynkLoginBtn').onclick = async () => {
    const btn = document.getElementById('rolynkLoginBtn')
    const username = document.getElementById('rolynkLoginUser').value.trim()
    const password = document.getElementById('rolynkLoginPass').value
    if(!username || !password){
        rkError('rolynkLoginError', 'fields_required'); return
    }
    rkBusy(btn, true)
    try {
        const { status, data } = await RolynkAuth.login(username, password)
        if(status === 200 && data.ok){
            rkOnAuthSuccess(data)
        } else if(status === 202 && data.twofa_required){
            rk2faChallenge = data.challenge_id
            rkShowPanel('rolynk2faPanel')
        } else if(data.error === 'discord_required' && data.discord_auth_url){
            // Compte inscrit mais Discord non lié : proposer la liaison.
            rkPendingCreds = { username, password }
            rkDiscordUrl = data.discord_auth_url
            document.getElementById('rolynkDiscordStatus').textContent = ''
            rkShowPanel('rolynkDiscordPanel')
        } else {
            rkError('rolynkLoginError', data.error || 'generic')
        }
    } catch(err){
        rkError('rolynkLoginError', 'network')
    } finally {
        rkBusy(btn, false)
    }
}

// --- Inscription ---

document.getElementById('rolynkRegBtn').onclick = async () => {
    const btn = document.getElementById('rolynkRegBtn')
    const username = document.getElementById('rolynkRegUser').value.trim()
    const password = document.getElementById('rolynkRegPass').value
    const password2 = document.getElementById('rolynkRegPass2').value
    if(!username || !password){
        rkError('rolynkRegError', 'fields_required'); return
    }
    if(password !== password2){
        rkError('rolynkRegError', 'password_mismatch'); return
    }
    rkBusy(btn, true)
    try {
        const { status, data } = await RolynkAuth.register(username, password, password2)
        if(status === 200 && data.ok){
            // Compte créé en 'pending' : passer à la liaison Discord.
            rkPendingCreds = { username, password }
            rkDiscordUrl = data.discord_auth_url
            document.getElementById('rolynkDiscordStatus').textContent = ''
            rkShowPanel('rolynkDiscordPanel')
        } else {
            rkError('rolynkRegError', data.error || 'generic')
        }
    } catch(err){
        rkError('rolynkRegError', 'network')
    } finally {
        rkBusy(btn, false)
    }
}

// --- Liaison Discord ---

document.getElementById('rolynkDiscordBtn').onclick = () => {
    if(!rkDiscordUrl) return
    document.getElementById('rolynkDiscordStatus').textContent = Lang.queryJS('rolynk.discordLinking')
    ipcRenderer.send(DISCORD_OPCODE.OPEN_LINK, rkDiscordUrl)
}

ipcRenderer.on(DISCORD_OPCODE.REPLY_LINK, async (_, type) => {
    // Ne réagir que si l'on est bien sur le panneau Discord.
    if(document.getElementById('rolynkDiscordPanel').style.display === 'none') return

    if(type === DISCORD_REPLY_TYPE.SUCCESS){
        document.getElementById('rolynkDiscordStatus').textContent = Lang.queryJS('rolynk.discordDone')
        // Compte activé : auto-login (déclenchera la 2FA, nouvel appareil).
        if(rkPendingCreds){
            try {
                const { status, data } = await RolynkAuth.login(rkPendingCreds.username, rkPendingCreds.password)
                if(status === 200 && data.ok){
                    rkOnAuthSuccess(data)
                } else if(status === 202 && data.twofa_required){
                    rk2faChallenge = data.challenge_id
                    rkShowPanel('rolynk2faPanel')
                } else {
                    // Repli : renvoyer vers la connexion manuelle.
                    rkShowPanel('rolynkLoginPanel')
                    rkError('rolynkLoginError', data.error || 'generic')
                }
            } catch(err){
                rkShowPanel('rolynkLoginPanel')
                rkError('rolynkLoginError', 'network')
            }
        }
    } else {
        document.getElementById('rolynkDiscordStatus').textContent = Lang.queryJS('rolynk.discordCancelled')
    }
})

// --- Code 2FA ---

document.getElementById('rolynk2faBtn').onclick = async () => {
    const btn = document.getElementById('rolynk2faBtn')
    const code = document.getElementById('rolynk2faCode').value.trim()
    if(!/^[0-9]{6}$/.test(code)){
        rkError('rolynk2faError', 'code_format'); return
    }
    if(!rk2faChallenge){
        rkError('rolynk2faError', 'generic'); return
    }
    rkBusy(btn, true)
    try {
        const { status, data } = await RolynkAuth.verify2fa(rk2faChallenge, code)
        if(status === 200 && data.ok){
            rkOnAuthSuccess(data)
        } else {
            rkError('rolynk2faError', data.error || 'generic')
        }
    } catch(err){
        rkError('rolynk2faError', 'network')
    } finally {
        rkBusy(btn, false)
    }
}

document.getElementById('rolynk2faResend').onclick = async () => {
    if(!rk2faChallenge) return
    const el = document.getElementById('rolynk2faError')
    try {
        await RolynkAuth.resend2fa(rk2faChallenge)
        el.innerHTML = Lang.queryJS('rolynk.twofaResent')
        el.style.color = '#4ed12f'
        el.classList.add('rkShow')
    } catch(err){
        rkError('rolynk2faError', 'network')
    }
}

// --- Navigation entre panneaux ---

document.getElementById('rolynkToRegister').onclick = () => rkShowPanel('rolynkRegisterPanel')
document.getElementById('rolynkToLogin').onclick = () => rkShowPanel('rolynkLoginPanel')

document.getElementById('rolynkAuthCancel').onclick = () => {
    rkResetFields()
    rkShowPanel('rolynkLoginPanel')
    switchView(getCurrentView(), VIEWS.loginOptions)
}

// Entrée = valider le champ courant.
for(const [inputId, btnId] of [
    ['rolynkLoginPass','rolynkLoginBtn'],
    ['rolynkRegPass2','rolynkRegBtn'],
    ['rolynk2faCode','rolynk2faBtn']
]){
    document.getElementById(inputId).addEventListener('keyup', (e) => {
        if(e.key === 'Enter') document.getElementById(btnId).click()
    })
}
