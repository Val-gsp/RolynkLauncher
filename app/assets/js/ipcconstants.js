// NOTE FOR THIRD-PARTY
// REPLACE THIS CLIENT ID WITH YOUR APPLICATION ID.
// SEE https://github.com/dscalzi/HeliosLauncher/blob/master/docs/MicrosoftAuth.md
exports.AZURE_CLIENT_ID = '1ce6e35a-126f-48fd-97fb-54d143ac6d45'
// SEE NOTE ABOVE.


// Opcodes
exports.MSFT_OPCODE = {
    OPEN_LOGIN: 'MSFT_AUTH_OPEN_LOGIN',
    OPEN_LOGOUT: 'MSFT_AUTH_OPEN_LOGOUT',
    REPLY_LOGIN: 'MSFT_AUTH_REPLY_LOGIN',
    REPLY_LOGOUT: 'MSFT_AUTH_REPLY_LOGOUT'
}
// Reply types for REPLY opcode.
exports.MSFT_REPLY_TYPE = {
    SUCCESS: 'MSFT_AUTH_REPLY_SUCCESS',
    ERROR: 'MSFT_AUTH_REPLY_ERROR'
}
// Error types for ERROR reply.
exports.MSFT_ERROR = {
    ALREADY_OPEN: 'MSFT_AUTH_ERR_ALREADY_OPEN',
    NOT_FINISHED: 'MSFT_AUTH_ERR_NOT_FINISHED'
}

exports.SHELL_OPCODE = {
    TRASH_ITEM: 'TRASH_ITEM'
}

// Discord OAuth2 (liaison des comptes crack Rolynk)
exports.DISCORD_OPCODE = {
    OPEN_LINK: 'DISCORD_OPEN_LINK',       // renderer -> main : ouvrir la fenêtre OAuth
    REPLY_LINK: 'DISCORD_REPLY_LINK'      // main -> renderer : résultat
}
exports.DISCORD_REPLY_TYPE = {
    SUCCESS: 'DISCORD_REPLY_SUCCESS',     // retour sur le callback = liaison OK
    CANCEL: 'DISCORD_REPLY_CANCEL'        // fenêtre fermée sans finir
}
// Préfixe de l'URL de callback (retour = succès).
exports.DISCORD_CALLBACK_PREFIX = 'https://auth.rolynk.fr/auth/discord/callback'