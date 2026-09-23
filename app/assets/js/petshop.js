'use strict'

const RARITY_ORDER = ['legendaire', 'epique', 'rare', 'commun']
const SPRITE_SIZES = { legendaire: 200, epique: 150, rare: 112, commun: 88 }

// Looping sprite strips baked by tools/render-shop-pets.cjs; a pet without one uses its species icon.
const SHOP_ART = require('../images/pets/shop/shop.json')
// Ultimates baked for the Cubees; the other pets' effects are coded in the mod and can't be previewed.
const EFFECTS = require('../images/pets/shop/effects.json')
const SHOWCASED = new Set(['legendaire', 'epique'])
const SPECIES_ICONS = {
    chien: 'M7 4 3 9l2 5 2-1v4a5 5 0 0 0 10 0v-4l2 1 2-5-4-5-3 2h-4zM9.5 12a1 1 0 1 0 0-.1zM14.5 12a1 1 0 1 0 0-.1zM12 16l-1.3-1h2.6z',
    chat: 'M5 3l4 5h6l4-5v9a7 7 0 0 1-14 0zM9.5 12a1 1 0 1 0 0-.1zM14.5 12a1 1 0 1 0 0-.1zM12 15.5l-1.2-1h2.4z',
    cubee: 'M6 5h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM9 10v2M15 10v2M9 15.5c2 1.3 4 1.3 6 0'
}

/** Crystal pet shop. The server owns the catalogue, prices and balance; a failed lookup never shows fake data. */
class PetShop {
    constructor({ document, getAccount, getHeaders, fetch, lang, apiBase, locale, onBalance, onRecharge }) {
        Object.assign(this, { document, getAccount, getHeaders, fetch, lang, apiBase, locale, onBalance, onRecharge })
        const $ = id => document.getElementById(id)
        this.grid = $('petGrid')
        this.status = $('petShopStatus')
        this.balanceText = $('petShopBalanceText')
        this.recharge = $('petShopRecharge')
        this.dialog = $('petBuyDialog')
        this.preview = $('petBuyPreview')
        this.title = $('petBuyTitle')
        this.text = $('petBuyText')
        this.note = $('petBuyNote')
        this.error = $('petBuyError')
        this.cancelButton = $('petBuyCancel')
        this.confirmButton = $('petBuyConfirm')
        this.filters = [...document.querySelectorAll('.petFilter')]
        this.effect = {
            dialog: $('petEffectDialog'), canvas: $('petEffectCanvas'), rarity: $('petEffectRarity'), name: $('petEffectName'),
            desc: $('petEffectDesc'), price: $('petEffectPrice'), buySlot: $('petEffectBuySlot'), frame: null, pet: null
        }
        this.rarity = ''
        this.pets = []
        this.cristaux = null
        this.state = 'idle'
        this.generation = 0
        this.busy = false

        this.recharge.textContent = lang('recharge')
        this.recharge.onclick = () => this.onRecharge()
        this.filters.forEach(button => {
            button.onclick = () => {
                this.rarity = button.dataset.rarity
                this.filters.forEach(b => b.setAttribute('aria-pressed', String(b === button)))
                this.render()
            }
        })
        this.cancelButton.onclick = () => this.dialog.close()
        this.confirmButton.onclick = () => this.buy()
        this.dialog.addEventListener('cancel', e => { if (this.busy) e.preventDefault() })
        this.dialog.addEventListener('close', () => { if (this.selected) this.focusCard(this.selected.id) })
        $('petEffectClose').onclick = () => this.effect.dialog.close()
        this.effect.dialog.addEventListener('click', e => { if (e.target === this.effect.dialog) this.effect.dialog.close() })
        this.effect.dialog.addEventListener('close', () => {
            this.document.defaultView.cancelAnimationFrame(this.effect.frame)
            this.effect.frame = null
            const pet = this.effect.pet
            this.effect.pet = null
            if (pet && !this.dialog.open) this.focusCard(pet.id, '.petCardEffect')
        })
    }

    format(count) {
        return Number(count).toLocaleString(this.locale)
    }

    reset() {
        this.generation++
        this.pets = []
        this.cristaux = null
        this.state = 'idle'
        this.busy = false
        this.dialog.close()
        this.effect.dialog.close()
        this.render()
    }

    async load() {
        if (this.busy) return
        const generation = ++this.generation
        const account = this.getAccount()
        if (this.state !== 'ready') {
            this.state = 'loading'
            this.render()
        }
        try {
            if (!account) throw new Error('auth_required')
            const response = await this.fetch(`${this.apiBase}/checkout/pets`, {
                headers: this.getHeaders(account), signal: AbortSignal.timeout(20000), cache: 'no-store'
            })
            const data = await response.json().catch(() => null)
            if (!response.ok || !data || !Array.isArray(data.pets)) throw new Error(data && data.error || 'unavailable')
            if (generation !== this.generation) return
            this.pets = data.pets.sort((a, b) => RARITY_ORDER.indexOf(a.rarete) - RARITY_ORDER.indexOf(b.rarete) || b.prix - a.prix)
            this.cristaux = data.cristaux
            this.state = 'ready'
            this.onBalance()
        } catch (err) {
            if (generation !== this.generation) return
            this.state = err.message === 'auth_required' ? 'reconnect' : 'error'
        }
        this.render()
    }

    icon(pet, size) {
        const art = SHOP_ART[pet.id]
        if (art) {
            const sprite = this.document.createElement('div')
            sprite.className = 'petSprite'
            sprite.setAttribute('aria-hidden', 'true')
            sprite.style.backgroundImage = `url("assets/images/pets/shop/${pet.id}.webp")`
            sprite.style.setProperty('--frames', art.frames)
            sprite.style.setProperty('--size', `${size}px`)
            sprite.style.setProperty('--duration', `${art.frames / art.fps}s`)
            return sprite
        }
        const svg = this.document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        svg.setAttribute('viewBox', '0 0 24 24')
        svg.setAttribute('width', Math.round(size * 0.57))
        svg.setAttribute('height', Math.round(size * 0.57))
        svg.setAttribute('aria-hidden', 'true')
        const path = this.document.createElementNS('http://www.w3.org/2000/svg', 'path')
        path.setAttribute('d', SPECIES_ICONS[pet.espece] || SPECIES_ICONS.cubee)
        svg.appendChild(path)
        return svg
    }

    setStatus(text, kind = '') {
        this.status.textContent = text
        this.status.dataset.kind = kind
    }

    render() {
        const ready = this.state === 'ready'
        this.balanceText.textContent = ready ? this.lang('balance', { count: this.format(this.cristaux) }) : '…'
        if (this.state === 'loading') this.setStatus(this.lang('loading'))
        else if (this.state === 'error') this.setStatus(this.lang('unavailable'), 'error')
        else if (this.state === 'reconnect') this.setStatus(this.lang('reconnect'), 'error')
        else if (this.status.dataset.kind !== 'success') this.setStatus('')
        this.grid.replaceChildren()
        if (this.state === 'error') {
            const retry = this.document.createElement('button')
            retry.type = 'button'
            retry.className = 'petRetry'
            retry.textContent = this.lang('retry')
            retry.onclick = () => this.load()
            this.grid.appendChild(retry)
        }
        if (!ready) return
        const tiers = RARITY_ORDER.filter(rarity => !this.rarity || rarity === this.rarity)
            .map(rarity => [rarity, this.pets.filter(pet => pet.rarete === rarity)])
            .filter(([, pets]) => pets.length)
        if (tiers.length === 0) {
            const empty = this.document.createElement('p')
            empty.className = 'petEmpty'
            empty.textContent = this.lang('empty')
            this.grid.appendChild(empty)
        }
        for (const [rarity, pets] of tiers) this.grid.appendChild(this.tier(rarity, pets))
    }

    el(tag, className, text) {
        const node = this.document.createElement(tag)
        node.className = className
        if (text != null) node.textContent = text
        return node
    }

    // One section per rarity: the rarer the pet, the bigger its showcase.
    tier(rarity, pets) {
        const section = this.el('section', `petTier petTier-${rarity} petRarity-${rarity}`)
        const heading = this.el('h3', 'petTierTitle', this.lang(`tier_${rarity}`))
        heading.id = `petTier-${rarity}`
        section.setAttribute('aria-labelledby', heading.id)
        const header = this.el('header', 'petTierHeader')
        header.append(heading, this.el('p', 'petTierIntro', this.lang(`tierIntro_${rarity}`)))
        const grid = this.el('div', 'petTierGrid')
        for (const pet of pets) grid.appendChild(this.card(pet))
        section.append(header, grid)
        return section
    }

    card(pet) {
        const el = this.el.bind(this)
        const d = this.document
        const card = el('article', `petCard petRarity-${pet.rarete}`)
        card.dataset.petId = pet.id
        const art = el('div', 'petCardArt')
        art.appendChild(this.icon(pet, SPRITE_SIZES[pet.rarete] || 88))
        const meta = el('div', 'petCardMeta')
        meta.append(el('span', 'petCardRarity', this.lang(`rarity_${pet.rarete}`)), el('span', 'petCardSpecies', this.lang(`species_${pet.espece}`)))
        const price = el('div', 'petCardPrice')
        const crystal = d.createElement('img')
        crystal.src = 'assets/images/shop/cristaux1.png'
        crystal.alt = ''
        price.append(crystal, el('span', '', this.format(pet.prix)))
        const button = this.buyButton(pet)
        const body = el('div', 'petCardBody')
        body.append(meta, el('h4', 'petCardName', pet.nom))
        const description = this.lang(`desc_${pet.id.replace(/_\d+$/, '')}`)
        if (description) body.appendChild(el('p', 'petCardDesc', description))
        const footer = el('div', 'petCardFooter')
        footer.append(price, button)
        body.appendChild(footer)
        if (SHOWCASED.has(pet.rarete)) {
            const preview = el('button', 'petCardEffect')
            preview.type = 'button'
            if (EFFECTS[pet.id]) {
                preview.textContent = this.lang('viewEffect')
                preview.onclick = () => this.showEffect(pet)
            } else {
                preview.textContent = this.lang('effectUnavailable')
                preview.disabled = true
            }
            body.appendChild(preview)
        }
        card.append(art, body)
        return card
    }

    buyButton(pet, before = () => {}) {
        const button = this.el('button', 'petCardBuy')
        button.type = 'button'
        const missing = pet.prix - this.cristaux
        if (pet.statut === 'possede') {
            button.textContent = this.lang('owned')
            button.disabled = true
        } else if (pet.statut === 'en_attente') {
            button.textContent = this.lang('pending')
            button.disabled = true
        } else if (missing > 0) {
            button.textContent = this.lang('missing', { count: this.format(missing) })
            button.classList.add('petCardBuyMissing')
            button.onclick = () => { before(); this.onRecharge() }
        } else {
            button.textContent = this.lang('buy')
            button.onclick = () => { before(); this.ask(pet) }
        }
        button.setAttribute('aria-label', `${button.textContent} — ${pet.nom}, ${this.format(pet.prix)}`)
        return button
    }

    // Plays the pet's ultimate in a loop, with a short pause between runs.
    async showEffect(pet) {
        const meta = EFFECTS[pet.id], fx = this.effect
        this.document.defaultView.cancelAnimationFrame(fx.frame)
        fx.pet = pet
        fx.dialog.className = `petRarity-${pet.rarete}`
        fx.rarity.textContent = this.lang(`rarity_${pet.rarete}`)
        fx.name.textContent = pet.nom
        fx.desc.textContent = this.lang(`desc_${pet.id.replace(/_\d+$/, '')}`) || ''
        const crystal = this.document.createElement('img')
        crystal.src = 'assets/images/shop/cristaux1.png'
        crystal.alt = ''
        fx.price.replaceChildren(crystal, this.el('span', '', this.format(pet.prix)))
        fx.buySlot.replaceChildren(this.buyButton(pet, () => fx.dialog.close()))
        fx.canvas.width = fx.canvas.height = meta.size
        fx.canvas.setAttribute('aria-label', this.lang('effectTitle', { name: pet.nom }))
        const context = fx.canvas.getContext('2d')
        context.clearRect(0, 0, meta.size, meta.size)
        if (!fx.dialog.open) fx.dialog.showModal()
        const sheet = new this.document.defaultView.Image()
        sheet.src = `assets/images/pets/shop/${pet.id}-effect.webp`
        try { await sheet.decode() } catch { return }
        if (fx.pet !== pet || !fx.dialog.open) return
        const cycle = meta.frames + Math.round(meta.fps * 0.8)
        let start = null, drawn = -1
        const tick = now => {
            if (start === null) start = now
            const frame = Math.min(Math.floor((now - start) * meta.fps / 1000) % cycle, meta.frames - 1)
            if (frame !== drawn) {
                drawn = frame
                context.clearRect(0, 0, meta.size, meta.size)
                context.drawImage(sheet, frame % meta.columns * meta.size, Math.floor(frame / meta.columns) * meta.size, meta.size, meta.size, 0, 0, meta.size, meta.size)
            }
            fx.frame = this.document.defaultView.requestAnimationFrame(tick)
        }
        fx.frame = this.document.defaultView.requestAnimationFrame(tick)
    }

    focusCard(id, selector = '.petCardBuy') {
        const card = [...this.grid.querySelectorAll('.petCard')].find(node => node.dataset.petId === id)
        const button = card && card.querySelector(selector)
        if (button && !button.disabled) button.focus()
    }

    ask(pet) {
        if (this.busy) return
        this.selected = pet
        this.confirmKey = this.key()
        this.preview.replaceChildren(this.icon(pet, 128))
        this.preview.className = `petRarity-${pet.rarete}`
        this.title.textContent = this.lang('confirmTitle', { name: pet.nom })
        this.text.textContent = this.lang('confirmText', { name: pet.nom, price: this.format(pet.prix), rest: this.format(this.cristaux - pet.prix) })
        this.note.textContent = this.lang('confirmNote')
        this.error.textContent = ''
        this.setBusy(false)
        this.dialog.showModal()
        this.cancelButton.focus()
    }

    key() {
        const account = this.getAccount()
        return account ? `${account.type}:${account.uuid}` : ''
    }

    setBusy(busy) {
        this.busy = busy
        this.confirmButton.disabled = busy
        this.cancelButton.disabled = busy
        this.confirmButton.textContent = this.lang(busy ? 'buying' : 'confirm')
    }

    async buy() {
        const pet = this.selected
        if (this.busy || !pet || this.confirmKey !== this.key()) return
        const generation = ++this.generation
        const account = this.getAccount()
        this.setBusy(true)
        this.error.textContent = ''
        try {
            const response = await this.fetch(`${this.apiBase}/checkout/pets/buy`, {
                method: 'POST',
                headers: { ...this.getHeaders(account), 'Content-Type': 'application/json' },
                body: JSON.stringify({ petId: pet.id }),
                signal: AbortSignal.timeout(20000),
                cache: 'no-store'
            })
            const data = await response.json().catch(() => null)
            if (generation !== this.generation) return
            if (!response.ok || !data || !data.pet) {
                const code = data && data.error
                this.error.textContent = this.lang(code === 'cristaux_insuffisants' ? 'errorInsufficient'
                    : code === 'deja_possede' ? 'errorOwned'
                        : code === 'auth_required' ? 'reconnect' : 'errorGeneric')
                this.setBusy(false)
                if (code === 'cristaux_insuffisants' || code === 'deja_possede') this.load()
                return
            }
            pet.statut = data.pet.statut
            this.cristaux = data.cristaux
            this.setStatus(this.lang('success', { name: pet.nom }), 'success')
            this.setBusy(false)
            this.dialog.close()
            this.render()
            this.onBalance()
        } catch {
            if (generation !== this.generation) return
            // The request may have reached the server: reload to show the real state instead of guessing.
            this.error.textContent = this.lang('errorNetwork')
            this.setBusy(false)
            this.load()
        }
    }
}

module.exports = PetShop
