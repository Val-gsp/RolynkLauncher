/** Plays pre-rendered frames from the original Blockbench idle bone animations. */
;(() => {
    const landing = document.getElementById('landingContainer')
    const stage = document.querySelector('.homePetStage')
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const pets = []
    let visible = false
    let frameRequest = null
    let previousTick = 0
    let elapsed = 0

    function lowMotion() {
        return reducedMotion.matches || ConfigManager.getPotatoMode()
    }
    function paint(pet, time) {
        const { tile, columns, frames, fps } = pet.meta
        const frame = Math.floor(time * fps / 1000) % frames
        if (pet.frame === frame) return
        pet.context.clearRect(0, 0, tile, tile)
        pet.context.drawImage(pet.sheet, frame % columns * tile, Math.floor(frame / columns) * tile, tile, tile, 0, 0, tile, tile)
        pet.frame = frame
    }
    function tick(now) {
        frameRequest = null
        if (!visible || document.hidden || lowMotion() || landing.classList.contains('shopOpen')) return
        if (previousTick) elapsed += Math.min(now - previousTick, 100)
        previousTick = now
        pets.forEach(pet => paint(pet, elapsed))
        frameRequest = requestAnimationFrame(tick)
    }
    function sync() {
        if (frameRequest != null) cancelAnimationFrame(frameRequest)
        frameRequest = null
        previousTick = 0
        const still = lowMotion()
        if (still) pets.forEach(pet => paint(pet, 0))
        if (visible && !document.hidden && !still && !landing.classList.contains('shopOpen')) {
            load()
            if (pets.length) frameRequest = requestAnimationFrame(tick)
        }
    }
    let loaded = false
    function load() {
        if (loaded) return
        loaded = true
        stage.querySelectorAll('img.homePet').forEach(poster => {
            const name = poster.getAttribute('src').split('/').pop().replace('.png', '')
            const meta = require(`./assets/images/pets/${name}-idle.json`)
            const sheet = new Image()
            sheet.onload = () => {
                const canvas = document.createElement('canvas')
                canvas.width = canvas.height = meta.tile
                canvas.className = poster.className
                canvas.setAttribute('role', 'img')
                canvas.setAttribute('aria-label', poster.alt)
                const context = canvas.getContext('2d')
                if (!context) return
                const pet = { meta, sheet, context, frame: -1 }
                paint(pet, 0)
                poster.replaceWith(canvas)
                pets.push(pet)
                sync()
            }
            // On load failure, the existing static poster stays visible.
            sheet.src = `assets/images/pets/${name}-idle.webp`
        })
    }
    new IntersectionObserver(entries => {
        visible = entries[0].isIntersecting
        sync()
    }, { threshold: 0 }).observe(stage)
    new MutationObserver(sync).observe(landing, { attributes: true, attributeFilter: ['style', 'class'] })
    document.addEventListener('visibilitychange', sync)
    document.addEventListener('shop-visibility', sync)
    reducedMotion.addEventListener('change', sync)
})()
