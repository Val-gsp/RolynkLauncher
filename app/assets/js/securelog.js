/**
 * SecureLog
 *
 * Enveloppe autour de helios-core's LoggerUtil qui censure, avant écriture,
 * les motifs susceptibles de révéler des informations sensibles : URLs,
 * chemins de fichiers .jar/.zip, jetons/chaînes base64 longues. À utiliser
 * partout où du code manipule des mods, des chemins du coffre (modvault.js)
 * ou des URLs privées, pour que ces informations ne finissent jamais dans
 * les fichiers de logs (qui peuvent être joints à un rapport de bug par un
 * joueur, donc traités comme un canal public).
 *
 * Ceci ne remplace pas la prudence normale : ne loguez pas explicitement un
 * nom de mod ou une URL dans le message lui-même en espérant que la
 * redaction s'en charge par magie sur des cas non prévus par les motifs
 * ci-dessous. Préférez des messages génériques ("Scellement de N entrées")
 * plutôt que des messages détaillés en clair.
 *
 * @module securelog
 */
const { LoggerUtil } = require('helios-core')

const SENSITIVE_PATTERNS = [
    /https?:\/\/[^\s'"]+/gi,
    /[a-zA-Z0-9_.\-/\\]+\.(?:jar|zip)\b/gi,
    /[A-Za-z0-9+/]{40,}={0,2}/g
]

function redactString(value){
    let out = value
    for(const re of SENSITIVE_PATTERNS){
        out = out.replace(re, '[redacted]')
    }
    return out
}

function redact(value, seen = new WeakSet()){
    if(typeof value === 'string'){
        return redactString(value)
    }
    if(value instanceof Error){
        const clone = new Error(redactString(value.message))
        clone.stack = value.stack ? redactString(value.stack) : undefined
        return clone
    }
    if (value && typeof value === 'object') {
        if (seen.has(value)) return '[circular]'
        seen.add(value)
        if (Array.isArray(value)) return value.map((item, i) =>
            i > 0 && typeof value[i - 1] === 'string' && /^--?(?:accessToken|password|token|secret)$/i.test(value[i - 1])
                ? '[redacted]' : redact(item, seen))
        const result = Object.create(null)
        for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
            result[key] = /token|password|secret|authorization|cookie|verifier|^code$|^md5$/i.test(key)
                ? '[redacted]' : 'value' in descriptor ? redact(descriptor.value, seen) : '[accessor]'
        }
        return result
    }
    return value
}

/**
 * Retourne un logger dont les méthodes redigent automatiquement les motifs
 * sensibles de chaque argument avant de les transmettre au logger sous-jacent.
 *
 * @param {string} name Nom du logger (affiché tel quel, à choisir neutre).
 */
exports.getSecureLogger = function(name){
    const base = LoggerUtil.getLogger(name)
    const wrap = (fn) => (...args) => fn.apply(base, args.map(value => redact(value)))
    return {
        info: wrap(base.info),
        warn: wrap(base.warn),
        error: wrap(base.error),
        debug: wrap(base.debug || base.info)
    }
}
exports.redact = redact
