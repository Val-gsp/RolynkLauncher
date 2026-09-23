'use strict'
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const destination = process.argv[2]
if (!destination || path.resolve(destination).startsWith(path.resolve(__dirname, '..') + path.sep)) throw new Error('Specify a private key destination outside this repository')
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
fs.writeFileSync(destination, privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 })
fs.writeFileSync(path.join(__dirname, '../vendor/helios-core/distribution-trust.json'), JSON.stringify({
    minimumSequence: 1, publicKey: publicKey.export({ type: 'spki', format: 'pem' })
}, null, 2) + '\n')
console.log('Signing key created; public trust pinned. Restrict private key ACLs and back it up securely before rollout.')
