/** Dashboard interactions reuse the launcher's existing shop and server flows. */
;(() => {
    const landing = document.getElementById('landingContainer')
    const feedback = document.getElementById('homeInstanceFeedback')
    const primary = landing.querySelector('[data-instance="v1"]')
    const selection = document.getElementById('server_selection_button')
    let revision = 0

    landing.querySelectorAll('[data-open-shop]').forEach(button => {
        button.addEventListener('click', () => openShop(button.dataset.openShop || 'cristaux'))
    })
    async function refreshInstance() {
        const current = ++revision
        try {
            const distro = await DistroAPI.getDistribution()
            if (current !== revision) return
            const server = distro.servers.find(item => /\bv1\b/i.test(item.rawServer.name))
            const selected = server != null && server.rawServer.id === ConfigManager.getSelectedServer()
            primary.setAttribute('aria-pressed', String(selected))
            primary.querySelector('.homeInstanceState').textContent = selected ? 'SÉLECTIONNÉE' : 'CHOISIR ↗'
            const active = distro.getServerById(ConfigManager.getSelectedServer())
            document.querySelector('.homeVersion').textContent = active ? `MINECRAFT ${active.rawServer.minecraftVersion}` : 'CHOISIS TON INSTANCE'
        } catch (_error) {
            primary.setAttribute('aria-pressed', 'false')
            feedback.textContent = 'Les instances sont momentanément indisponibles.'
        }
    }
    primary.addEventListener('click', async () => {
        primary.disabled = true
        feedback.textContent = ''
        try {
            const distro = await DistroAPI.getDistribution()
            const server = distro.servers.find(item => /\bv1\b/i.test(item.rawServer.name))
            if (server) {
                updateSelectedServer(server)
                refreshServerStatus(true)
                feedback.textContent = 'Rolynk V1 est prête. Clique sur Jouer pour démarrer.'
                document.getElementById('launch_button').focus()
            } else {
                await toggleServerSelection(true)
            }
        } catch (_error) {
            feedback.textContent = 'Impossible de charger les instances. Réessaie dans un instant.'
        } finally {
            primary.disabled = false
            refreshInstance()
        }
    })
    new MutationObserver(refreshInstance).observe(selection, { childList: true, characterData: true, subtree: true })
    refreshInstance()
})()
