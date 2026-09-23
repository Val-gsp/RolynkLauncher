'use strict'
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    return JSON.stringify(value)
}
function payload(distribution) {
    const { _signature, ...body } = distribution
    return Buffer.from(canonical(body))
}
function verify(distribution, trust = JSON.parse(fs.readFileSync(path.join(__dirname, 'distribution-trust.json'), 'utf8')), now = Date.now()) {
    const stamp = distribution && distribution._security
    if (!stamp || !Number.isSafeInteger(stamp.sequence) || stamp.sequence < trust.minimumSequence ||
        !Number.isSafeInteger(stamp.issuedAt) || !Number.isSafeInteger(stamp.expiresAt) ||
        stamp.issuedAt > now + 300000 || stamp.expiresAt <= now ||
        stamp.expiresAt - stamp.issuedAt > 31 * 86400000 || stamp.expiresAt <= stamp.issuedAt) throw new Error('Distribution expired or missing release metadata')
    if (typeof distribution._signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(distribution._signature) ||
        !crypto.verify(null, payload(distribution), trust.publicKey, Buffer.from(distribution._signature, 'base64'))) throw new Error('Distribution signature invalid')
    return distribution
}
module.exports = { canonical, payload, verify }
