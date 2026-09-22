'use strict'

/** Account-bound subscription UI. A failed lookup never becomes "not subscribed". */
class ShopSubscription {
    constructor({ document, window, getAccount, getHeaders, fetch, lang, apiBase, onLayout = () => {} }) {
        Object.assign(this, { document, window, getAccount, getHeaders, fetch, lang, apiBase, onLayout })
        this.buy = document.querySelector('[data-pack-id="prestige"]')
        this.manage = document.getElementById('shopSubscriptionManage')
        this.label = document.getElementById('shopSubscriptionLabel')
        this.more = document.getElementById('shopSubscriptionMore')
        this.menu = document.getElementById('shopSubscriptionMenu')
        this.cancelButton = document.getElementById('shopSubscriptionCancel')
        this.note = document.getElementById('shopSubscriptionNote')
        this.dialog = document.getElementById('shopSubscriptionDialog')
        this.confirm = document.getElementById('shopSubscriptionConfirm')
        this.keep = document.getElementById('shopSubscriptionKeep')
        this.error = document.getElementById('shopSubscriptionError')
        this.buyLabel = this.buy.textContent
        this.generation = 0
        this.state = 'loading'
        this.open = false
        this.busy = false
        this.more.onclick = () => this.setMenu(this.menu.hidden)
        this.cancelButton.onclick = () => this.showConfirmation()
        this.keep.onclick = () => this.dialog.close()
        this.confirm.onclick = () => this.cancel()
        this.dialog.addEventListener('cancel', e => { if (this.busy) e.preventDefault() })
        this.dialog.addEventListener('close', () => { if (!this.more.hidden && !this.manage.hidden) this.more.focus() })
        document.addEventListener('click', e => {
            if (!this.manage.contains(e.target)) this.setMenu(false)
        })
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape' && !this.menu.hidden) {
                this.setMenu(false)
                this.more.focus()
                e.stopPropagation()
            }
        })
        this.more.addEventListener('keydown', e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); this.setMenu(true) }
        })
        document.addEventListener('shop-visibility', e => {
            this.open = e.detail
            this.setMenu(false)
            if (this.open) this.refresh()
            else this.dialog.close()
        })
        document.addEventListener('shop-account-changed', () => {
            this.generation++
            this.subscription = null
            this.state = 'loading'
            this.busy = false
            this.dialog.close()
            this.setMenu(false)
            this.render()
            if (this.open) this.refresh()
        })
        window.addEventListener('focus', () => { if (this.open && !this.busy && !this.dialog.open) this.refresh() })
        window.setInterval(() => { if (this.open && !this.busy && !this.dialog.open) this.refresh() }, 45000)
        this.render()
    }

    key() {
        const account = this.getAccount()
        return account ? `${account.type}:${account.uuid}` : ''
    }

    setMenu(open) {
        this.menu.hidden = !open
        this.more.setAttribute('aria-expanded', String(open))
        if (open) {
            this.cancelButton.focus()
            this.menu.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
    }

    date(timestamp) {
        return timestamp ? new Date(timestamp * 1000).toLocaleDateString(this.lang('locale'), { day: 'numeric', month: 'long', year: 'numeric' }) : ''
    }

    render() {
        const sub = this.subscription
        const managed = this.state === 'ready' && sub != null
        this.buy.hidden = managed
        this.manage.hidden = !managed
        this.note.hidden = true
        this.buy.setAttribute('aria-disabled', String(this.state !== 'ready'))
        this.buy.textContent = this.state === 'loading' ? this.lang('loading')
            : this.state === 'error' ? this.lang('retry') : this.buyLabel
        if (managed) {
            this.label.textContent = this.lang(sub.cancelAtPeriodEnd ? 'ending' : ['active', 'trialing'].includes(sub.status) ? 'active' : 'paymentPending')
            this.more.hidden = sub.cancelAtPeriodEnd
            this.cancelButton.disabled = this.busy
            if (sub.cancelAtPeriodEnd) {
                this.note.textContent = sub.currentPeriodEnd ? this.lang('endsOn', { date: this.date(sub.currentPeriodEnd) }) : this.lang('ending')
                this.note.hidden = false
            }
        } else if (this.state === 'error') {
            this.note.hidden = false
            this.note.textContent = this.lang(this.lastError === 'auth_required' ? 'reconnect' : 'unavailable')
        }
        this.onLayout()
    }

    async request(path, account, method = 'GET') {
        const response = await this.fetch(`${this.apiBase}/checkout/subscription${path}`, {
            method, headers: this.getHeaders(account), signal: AbortSignal.timeout(20000), cache: 'no-store'
        })
        const data = await response.json().catch(() => null)
        if (!response.ok || !data || !Object.prototype.hasOwnProperty.call(data, 'subscription')) {
            throw new Error(data && data.error || 'unavailable')
        }
        return data.subscription
    }

    async refresh() {
        if (this.busy) return
        const generation = ++this.generation
        const key = this.key()
        const account = this.getAccount()
        this.state = 'loading'
        this.subscription = null
        this.setMenu(false)
        this.render()
        try {
            if (!account) throw new Error('auth_required')
            const subscription = await this.request('', account)
            if (generation !== this.generation || key !== this.key()) return
            this.subscription = subscription
            this.state = 'ready'
        } catch (err) {
            if (generation !== this.generation || key !== this.key()) return
            this.state = 'error'
            this.lastError = err.message
        }
        this.render()
    }

    canSubscribe() {
        if (this.state === 'error') this.refresh()
        return this.state === 'ready' && this.subscription == null
    }

    showConfirmation() {
        this.setMenu(false)
        if (!this.subscription || this.subscription.cancelAtPeriodEnd || this.busy) return
        this.confirmKey = this.key()
        this.error.textContent = ''
        this.confirm.disabled = false
        this.keep.disabled = false
        this.confirm.textContent = this.lang('confirm')
        this.document.getElementById('shopSubscriptionConfirmText').textContent = this.subscription.currentPeriodEnd
            ? this.lang('confirmText', { date: this.date(this.subscription.currentPeriodEnd) }) : this.lang('confirmTextFallback')
        this.dialog.showModal()
        this.keep.focus()
    }

    async cancel() {
        if (this.busy || this.confirmKey !== this.key()) return
        const generation = ++this.generation
        const account = this.getAccount()
        this.busy = true
        this.confirm.disabled = true
        this.keep.disabled = true
        this.confirm.textContent = this.lang('cancelling')
        this.error.textContent = ''
        try {
            const subscription = await this.request('/cancel', account, 'POST')
            if (generation !== this.generation || this.confirmKey !== this.key()) return
            this.subscription = subscription
            this.state = 'ready'
            this.dialog.close()
        } catch (err) {
            if (generation !== this.generation || this.confirmKey !== this.key()) return
            this.error.textContent = this.lang(err.message === 'auth_required' ? 'reconnect' : 'cancelError')
        } finally {
            if (generation === this.generation) {
                this.busy = false
                this.confirm.disabled = false
                this.keep.disabled = false
                this.confirm.textContent = this.lang('confirm')
                this.render()
            }
        }
    }
}

module.exports = ShopSubscription
