/**
 * RolynkAuth
 *
 * Client d'authentification pour les comptes "crack" Rolynk. Dialogue avec
 * l'API d'auth (https://auth.rolynk.fr/auth) : inscription, connexion, 2FA,
 * session. Les comptes validés sont stockés par le ConfigManager avec le
 * type 'rolynk'. Le jeton de session est chiffré via safeStorage d'Electron.
 *
 * @module rolynkauth
 */
const crypto = require('crypto')
const os = require('os')
const { LoggerUtil } = require('helios-core')
const ConfigManager = require('./configmanager')

const logger = LoggerUtil.getLogger('RolynkAuth')

// Base de l'API. Modifiable pour pointer sur un environnement de test.
const API_BASE = 'https://auth.rolynk.fr/auth'

// --- Stockage sécurisé du jeton (safeStorage via @electron/remote) ---

function getSafeStorage() {
    try {
        return require('@electron/remote').safeStorage
    } catch (err) {
        return null
    }
}

function encodeToken(token) {
    const ss = getSafeStorage()
    if (ss && ss.isEncryptionAvailable()) {
        return { enc: true, v: ss.encryptString(token).toString('base64') }
    }
    // Repli (ex. Linux sans trousseau) : simple base64, non chiffré.
    logger.warn('safeStorage indisponible, jeton stocké non chiffré.')
    return { enc: false, v: Buffer.from(token, 'utf8').toString('base64') }
}

function decodeToken(stored) {
    if (stored == null) return null
    try {
        if (stored.enc) {
            const ss = getSafeStorage()
            if (ss && ss.isEncryptionAvailable()) {
                return ss.decryptString(Buffer.from(stored.v, 'base64'))
            }
            return null
        }
        return Buffer.from(stored.v, 'base64').toString('utf8')
    } catch (err) {
        logger.error('Échec du déchiffrement du jeton de session.', err)
        return null
    }
}

// --- Empreinte machine (device_fp) : stable, anonyme ---

function deviceFingerprint() {
    const id = ConfigManager.getDeviceId()
    const raw = `${id}|${os.hostname()}|${os.platform()}|${os.arch()}`
    return crypto.createHash('sha256').update(raw).digest('hex')
}
exports.deviceFingerprint = deviceFingerprint

// --- Appels HTTP ---

async function apiPost(path, body, token) {
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
    })
    let data = {}
    try { data = await res.json() } catch (e) { /* corps vide */ }
    return { status: res.status, data }
}

async function apiGet(path, token) {
    const headers = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const res = await fetch(`${API_BASE}${path}`, { headers })
    let data = {}
    try { data = await res.json() } catch (e) { /* corps vide */ }
    return { status: res.status, data }
}

// --- API publique du module ---

/** Inscription. Renvoie {status, data} ; data contient discord_auth_url en cas de succès. */
exports.register = (username, password, passwordConfirm) =>
    apiPost('/register', { username, password, password_confirm: passwordConfirm })

/** Connexion. 200 → jeton ; 202 → 2FA requise (challenge_id) ; 409 → 2fa_dm_failed. */
exports.login = (username, password) =>
    apiPost('/login', { username, password, device_fp: deviceFingerprint() })

/** Vérification du code 2FA. 200 → jeton. */
exports.verify2fa = (challengeId, code) =>
    apiPost('/verify-2fa', { challenge_id: challengeId, code, device_fp: deviceFingerprint() })

/** Renvoi d'un code 2FA. */
exports.resend2fa = (challengeId) =>
    apiPost('/2fa/resend', { challenge_id: challengeId })

/** Valide un jeton de session existant. */
exports.session = (token) => apiGet('/session', token)

/** Invalide un jeton de session. */
exports.logout = (token) => apiPost('/logout', {}, token)

/**
 * Arme la session de jeu (pont jeton / v2). À appeler juste avant de lancer
 * le jeu : l'API enregistre une autorisation de connexion à usage unique pour
 * l'IP courante et une courte durée. Le plugin serveur auto-connecte alors le
 * joueur sans qu'il ait à taper /login en jeu.
 */
exports.armGameSession = (token) => apiPost('/game-session', {}, token)

/**
 * Persiste un compte Rolynk après authentification réussie.
 * @param {Object} data Objet renvoyé par login/verify-2fa : {token, uuid, username, expires_at, ref_code?}
 * @returns {Object} Le compte créé.
 */
exports.persistAccount = function (data) {
    const acc = ConfigManager.addRolynkAuthAccount(
        data.uuid,
        data.username,
        encodeToken(data.token),
        data.expires_at || null,
        data.ref_code || null
    )
    ConfigManager.save()
    return acc
}

/** Récupère le jeton de session déchiffré d'un compte. */
exports.getAccountToken = function (account) {
    return decodeToken(account?.rolynk?.sessionToken)
}

/**
 * Valide un compte Rolynk. En v1, la vraie authentification se fait en jeu
 * (LibreLogin /login), donc on ne bloque jamais le lancement : on renvoie
 * true même si le jeton API a expiré (il ne sert pas au lancement du jeu).
 */
exports.validateAccount = async function () {
    return true
}
