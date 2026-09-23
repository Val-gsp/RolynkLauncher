'use strict'
// Offline signing: keep the private key outside the web root and outside Git.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { payload, verify } = require('../vendor/helios-core/distribution-signature')
const { containedPath } = require('../app/assets/js/security')

function signDistribution(distribution, key, sequence, now = Date.now()) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Positive release sequence required')
    const result = structuredClone(distribution)
    result._security = { sequence, issuedAt: now, expiresAt: now + 30 * 86400000 }
    result._signature = crypto.sign(null, payload(result), key).toString('base64')
    return result
}
function addDigests(distribution, webRoot) {
    function visit(module) {
        const url = new URL(module.artifact.url)
        if (url.protocol !== 'https:' || url.hostname !== 'files.rolynk.fr' || url.username || url.password || url.port || url.search) throw new Error('Unexpected artifact URL')
        const file = containedPath(webRoot, decodeURIComponent(url.pathname).replace(/^\//, ''))
        const data = fs.readFileSync(file)
        if (!fs.lstatSync(file).isFile() || data.length !== module.artifact.size ||
            crypto.createHash('md5').update(data).digest('hex') !== module.artifact.MD5) throw new Error('Artifact changed: rebuild the manifest before signing')
        module.artifact.SHA256 = crypto.createHash('sha256').update(data).digest('hex')
        for (const child of module.subModules || []) visit(child)
    }
    for (const server of distribution.servers) for (const module of server.modules) visit(module)
}
if (require.main === module) {
    const [input, webRoot, keyFile, output, sequence] = process.argv.slice(2)
    if (!sequence || path.resolve(input) === path.resolve(output)) throw new Error('Usage: node sign-distribution.cjs input.json web-root private.pem signed.json sequence (separate output required)')
    const distribution = JSON.parse(fs.readFileSync(input, 'utf8'))
    addDigests(distribution, path.resolve(webRoot))
    const signed = signDistribution(distribution, fs.readFileSync(keyFile), Number(sequence))
    verify(signed)
    require('../vendor/helios-core/rolynk-security').validateDistribution(signed)
    fs.writeFileSync(output, JSON.stringify(signed, null, 2) + '\n', { flag: 'wx' })
    console.log('Signed distribution prepared. Publish only after validation.')
}
module.exports = { signDistribution, addDigests }
