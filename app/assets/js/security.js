'use strict'
const fs = require('fs')
const path = require('path')

function protectedStorage(storage) {
    return !!storage && storage.isEncryptionAvailable() &&
        (!storage.getSelectedStorageBackend || storage.getSelectedStorageBackend() !== 'basic_text')
}

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c])
}

function checkedHttpsUrl(value, allowedHosts) {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        !allowedHosts.includes(url.hostname)) throw new Error('Untrusted external URL')
    return url.href
}

function containedPath(root, relative) {
    if (typeof relative !== 'string' || !relative || relative.includes(':') || relative.includes('\0') ||
        path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative) ||
        relative.replaceAll('\\', '/').split('/').some(p => p === '..' || p === '.')) throw new Error('Unsafe content path')
    const resolved = path.resolve(root, relative)
    const rel = path.relative(path.resolve(root), resolved)
    if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Content path escapes root')
    let current = path.parse(resolved).root
    for (const segment of resolved.slice(current.length).split(path.sep)) {
        current = path.join(current, segment)
        try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked content path') }
        catch (err) { if (err.code !== 'ENOENT') throw err }
    }
    return resolved
}

// Only unlink explicitly owned regular files. No recursive writes or traversal.
function removeOwnedFiles(root, files) {
    for (const file of files) {
        const target = containedPath(root, path.relative(root, file))
        try {
            if (fs.lstatSync(target).isFile()) fs.unlinkSync(target)
        } catch (err) {
            if (err.code !== 'ENOENT') throw err
        }
    }
}

module.exports = { protectedStorage, escapeHtml, checkedHttpsUrl, containedPath, removeOwnedFiles }
module.exports.oauthCallback = function(uri, redirect, state) {
    try {
        const url = new URL(uri), expected = new URL(redirect)
        if (!state || url.origin !== expected.origin || url.pathname !== expected.pathname ||
            url.username || url.password || url.searchParams.getAll('state').length !== 1 ||
            url.searchParams.get('state') !== state ||
            (!url.searchParams.get('code') && !url.searchParams.get('error'))) return null
        return Object.fromEntries(url.searchParams)
    } catch (_) { return null }
}
// Preserve simple help formatting while stripping active HTML from API errors.
module.exports.sanitizeHtml = value => require('dompurify')(globalThis.window).sanitize(String(value ?? ''), {
    ALLOWED_TAGS: ['br', 'p', 'b', 'strong', 'i', 'em', 'code', 'ul', 'ol', 'li'],
    ALLOWED_ATTR: []
})
