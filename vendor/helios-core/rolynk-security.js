'use strict'
const fs = require('fs')
const path = require('path')

function protectedStorage(storage) {
    return !!storage && storage.isEncryptionAvailable() &&
        (!storage.getSelectedStorageBackend || storage.getSelectedStorageBackend() !== 'basic_text')
}

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
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

function safePath(root, ...parts) {
    for (const part of parts) {
        if (typeof part !== 'string' || !part || part.includes(':') || path.win32.isAbsolute(part) || path.posix.isAbsolute(part) ||
            part.replaceAll('\\', '/').split('/').some(s => s === '..' || s === '.')) throw new Error('Unsafe distribution path')
    }
    return containedPath(root, parts.join('/'))
}
function validateDistribution(distro) {
    require('./distribution-signature').verify(distro)
    if (!distro || !Array.isArray(distro.servers) || distro.servers.length < 1 || distro.servers.length > 30) throw new Error('Invalid distribution')
    const servers = new Set()
    let count = 0
    function module(m, depth) {
        if (++count > 5000 || depth > 25 || !m || typeof m.id !== 'string' || m.id.length > 240 ||
            !m.artifact || !/^[a-f0-9]{32}$/i.test(m.artifact.MD5) || !/^[a-f0-9]{64}$/i.test(m.artifact.SHA256) ||
            !Number.isSafeInteger(m.artifact.size) || m.artifact.size < 0 || m.artifact.size > 2 * 1024 ** 3) throw new Error('Invalid distribution module')
        checkedHttpsUrl(m.artifact.url, ['files.rolynk.fr'])
        if (m.artifact.path != null) safePath(process.cwd(), m.artifact.path)
        if (m.type === 'VersionManifest' && !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,120}$/.test(m.id)) throw new Error('Invalid version ID')
        if (m.subModules != null) {
            if (!Array.isArray(m.subModules)) throw new Error('Invalid submodules')
            m.subModules.forEach(child => module(child, depth + 1))
        }
    }
    for (const server of distro.servers) {
        if (!server || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,120}$/.test(server.id) || servers.has(server.id) ||
            !Array.isArray(server.modules)) throw new Error('Invalid distribution server')
        servers.add(server.id)
        if (server.icon) checkedHttpsUrl(server.icon, ['files.rolynk.fr'])
        server.modules.forEach(m => module(m, 0))
    }
    return distro
}
function assertNoLinks(target) {
    const resolved = path.resolve(target)
    let current = path.parse(resolved).root
    for (const part of resolved.slice(current.length).split(path.sep)) {
        current = path.join(current, part)
        try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Linked download destination') }
        catch (err) { if (err.code !== 'ENOENT') throw err }
    }
}
module.exports = { ...module.exports, safePath, validateDistribution, assertNoLinks }
