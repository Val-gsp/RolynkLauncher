/**
 * ServerList
 *
 * Keeps the instance's server in Minecraft's multiplayer list (`servers.dat`). The launcher joins
 * through Quick Play, and Minecraft only records a Quick Play server as a *hidden* entry
 * (QuickPlay#joinMultiplayerWorld -> ServerList#add(data, true)), so after a disconnect players
 * land on an empty list. Before each launch the server is made visible (an existing entry for the
 * same address is un-hidden, otherwise one is added at the top); every other entry and field is
 * written back unchanged.
 *
 * `servers.dat` is uncompressed, big-endian NBT. The codec below round-trips every tag type and
 * keeps strings as raw bytes, so names in Java's modified UTF-8 survive untouched.
 *
 * @module serverlist
 */
const fs = require('fs-extra')
const path = require('path')

const TAG = { End: 0, Byte: 1, Short: 2, Int: 3, Long: 4, Float: 5, Double: 6, ByteArray: 7, String: 8, List: 9, Compound: 10, IntArray: 11, LongArray: 12 }

// --- NBT codec: a tag is { type, value }; a compound's value is a Map, a list's { type, items } ---

function decode(buffer){
    let offset = 0
    const take = size => { const start = offset; offset += size; return start }
    function payload(type){
        switch(type){
            case TAG.Byte: return buffer.readInt8(take(1))
            case TAG.Short: return buffer.readInt16BE(take(2))
            case TAG.Int: return buffer.readInt32BE(take(4))
            case TAG.Long: return buffer.readBigInt64BE(take(8))
            case TAG.Float: return buffer.readFloatBE(take(4))
            case TAG.Double: return buffer.readDoubleBE(take(8))
            case TAG.ByteArray: { const length = buffer.readInt32BE(take(4)); return Buffer.from(buffer.subarray(take(length), offset)) }
            case TAG.String: { const length = buffer.readUInt16BE(take(2)); return Buffer.from(buffer.subarray(take(length), offset)) }
            case TAG.List: {
                const itemType = buffer.readUInt8(take(1)), length = buffer.readInt32BE(take(4))
                return { type: itemType, items: Array.from({ length }, () => payload(itemType)) }
            }
            case TAG.Compound: {
                const entries = new Map()
                for(;;){
                    const childType = buffer.readUInt8(take(1))
                    if(childType === TAG.End) return entries
                    const name = payload(TAG.String).toString('utf8')
                    entries.set(name, { type: childType, value: payload(childType) })
                }
            }
            case TAG.IntArray: { const length = buffer.readInt32BE(take(4)); return Array.from({ length }, () => buffer.readInt32BE(take(4))) }
            case TAG.LongArray: { const length = buffer.readInt32BE(take(4)); return Array.from({ length }, () => buffer.readBigInt64BE(take(8))) }
            default: throw new Error(`Unknown NBT tag ${type} at ${offset - 1}`)
        }
    }
    const rootType = buffer.readUInt8(take(1))
    if(rootType !== TAG.Compound) throw new Error('servers.dat root is not a compound')
    payload(TAG.String) // Root name, always empty.
    return payload(TAG.Compound)
}

function encode(root){
    const chunks = []
    const fixed = (size, write) => { const b = Buffer.alloc(size); write(b); chunks.push(b) }
    function string(bytes){ fixed(2, b => b.writeUInt16BE(bytes.length)); chunks.push(bytes) }
    function payload(type, value){
        switch(type){
            case TAG.Byte: return fixed(1, b => b.writeInt8(value))
            case TAG.Short: return fixed(2, b => b.writeInt16BE(value))
            case TAG.Int: return fixed(4, b => b.writeInt32BE(value))
            case TAG.Long: return fixed(8, b => b.writeBigInt64BE(value))
            case TAG.Float: return fixed(4, b => b.writeFloatBE(value))
            case TAG.Double: return fixed(8, b => b.writeDoubleBE(value))
            case TAG.ByteArray: fixed(4, b => b.writeInt32BE(value.length)); return chunks.push(value)
            case TAG.String: return string(value)
            case TAG.List:
                fixed(5, b => { b.writeUInt8(value.type); b.writeInt32BE(value.items.length, 1) })
                return value.items.forEach(item => payload(value.type, item))
            case TAG.Compound:
                for(const [name, child] of value){
                    fixed(1, b => b.writeUInt8(child.type))
                    string(Buffer.from(name, 'utf8'))
                    payload(child.type, child.value)
                }
                return fixed(1, b => b.writeUInt8(TAG.End))
            case TAG.IntArray: fixed(4, b => b.writeInt32BE(value.length)); return value.forEach(v => fixed(4, b => b.writeInt32BE(v)))
            case TAG.LongArray: fixed(4, b => b.writeInt32BE(value.length)); return value.forEach(v => fixed(8, b => b.writeBigInt64BE(v)))
            default: throw new Error(`Unknown NBT tag ${type}`)
        }
    }
    fixed(1, b => b.writeUInt8(TAG.Compound))
    string(Buffer.alloc(0))
    payload(TAG.Compound, root)
    return Buffer.concat(chunks)
}

// --- Server list ---

const text = value => ({ type: TAG.String, value: Buffer.from(value, 'utf8') })

/**
 * Makes `address` a visible entry of `<gameDir>/servers.dat`.
 *
 * @param {string} gameDir The instance directory.
 * @param {string} name Display name used for a new entry, or for an un-hidden Quick Play entry.
 * @param {string} address Exactly the address given to Quick Play (`host:port`), which Minecraft
 * matches verbatim when it looks the server up.
 * @returns {'unchanged'|'shown'|'added'} What was done.
 */
exports.ensureServer = function(gameDir, name, address){
    const file = path.join(gameDir, 'servers.dat')
    const root = fs.existsSync(file) ? decode(fs.readFileSync(file)) : new Map()
    let servers = root.get('servers')
    if(servers == null || servers.type !== TAG.List || (servers.value.items.length > 0 && servers.value.type !== TAG.Compound)){
        servers = { type: TAG.List, value: { type: TAG.Compound, items: [] } }
        root.set('servers', servers)
    }
    servers.value.type = TAG.Compound
    const entries = servers.value.items
    const ip = entry => entry.get('ip')?.value?.toString('utf8')
    const hidden = entry => entry.get('hidden')?.value === 1

    const matching = entries.filter(entry => ip(entry) === address)
    let result
    if(matching.some(entry => !hidden(entry))){
        return 'unchanged'
    } else if(matching.length > 0){
        // Quick Play's hidden entry keeps the player's resource-pack choice; it only needs a name.
        const entry = matching[0]
        entry.set('hidden', { type: TAG.Byte, value: 0 })
        entry.set('name', text(name))
        entries.splice(entries.indexOf(entry), 1)
        entries.unshift(entry)
        result = 'shown'
    } else {
        entries.unshift(new Map([['name', text(name)], ['ip', text(address)], ['hidden', { type: TAG.Byte, value: 0 }]]))
        result = 'added'
    }
    // Same swap as Minecraft's own ServerList#save, so a crash never leaves a truncated list.
    const temp = file + '.rolynk-tmp'
    fs.writeFileSync(temp, encode(root))
    fs.moveSync(temp, file, { overwrite: true })
    return result
}

exports._nbt = { decode, encode, TAG }
