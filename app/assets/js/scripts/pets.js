/**
 * Home hero: plays the pets' original Blockbench animations from the atlases baked by
 * tools/render-pets.cjs. Idle loops, `pet` answers the pointer, `ultimate` plays on click and now
 * and then on its own. Every animation of a pet shares one canvas and one pixel scale (each atlas
 * carries its `rect` relative to the idle tile), so switching never makes the pet jump.
 *
 * Everything pauses offscreen, behind the shop, when the window is hidden, with reduced motion and
 * in Potato Mode. The static posters stay in place if an atlas fails to load.
 */
;(() => {
    const landing = document.getElementById('landingContainer')
    const dashboard = document.getElementById('homeDashboard')
    const hero = landing.querySelector('.homeHero')
    const stage = hero.querySelector('.homePetStage')
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    const NAMES = { forest_keeper: 'Forest Keeper', arctic_witch: 'Arctic Witch', meowgician: 'Meowgician' }
    // Ultimates take turns in this order; the Forest Keeper's golden pillar opens the show.
    const ULTIMATE_ORDER = ['forest_keeper', 'arctic_witch', 'meowgician']
    const pets = []
    let visible = false
    let frameRequest = null
    let previousTick = 0
    let elapsed = 0
    let nextAction = 2500
    let actionCount = 0
    let ultimateTurn = 0

    function lowMotion() {
        return reducedMotion.matches || ConfigManager.getPotatoMode()
    }
    function running() {
        return visible && !document.hidden && !lowMotion() && !landing.classList.contains('shopOpen')
    }

    // --- Drawing ---

    function paint(pet, still = false) {
        const anim = still ? 'idle' : pet.anim
        const meta = pet.meta[anim]
        const sheet = pet.images[anim]
        if (!sheet) return
        const time = still ? 0 : anim === 'idle' ? elapsed : elapsed - pet.start
        const index = Math.floor(time * meta.fps / 1000)
        const frame = meta.loop ? index % meta.frames : Math.min(index, meta.frames - 1)
        const key = anim + frame
        if (pet.key === key) return
        pet.key = key
        const { width, height, columns, rect } = meta
        const tile = pet.meta.idle.width
        pet.context.clearRect(0, 0, pet.canvas.width, pet.canvas.height)
        pet.context.drawImage(sheet, frame % columns * width, Math.floor(frame / columns) * height, width, height,
            (rect.x - pet.bounds.x) * tile, (rect.y - pet.bounds.y) * tile, rect.w * tile, rect.h * tile)
    }
    function tick(now) {
        frameRequest = null
        if (!running()) return
        if (previousTick) elapsed += Math.min(now - previousTick, 100)
        previousTick = now
        for (const pet of pets) {
            if (pet.anim !== 'idle' && elapsed - pet.start >= pet.meta[pet.anim].duration * 1000) finish(pet)
            paint(pet)
        }
        direct()
        frameRequest = requestAnimationFrame(tick)
    }
    function sync() {
        if (frameRequest != null) cancelAnimationFrame(frameRequest)
        frameRequest = null
        previousTick = 0
        const still = lowMotion()
        hero.classList.toggle('isStill', !running())
        dashboard.classList.toggle('isLowMotion', still)
        if (still) {
            pets.forEach(finish)
            pets.forEach(pet => paint(pet, true))
        }
        if (visible && !document.hidden && !still && !landing.classList.contains('shopOpen')) {
            load()
            if (pets.length) frameRequest = requestAnimationFrame(tick)
        }
    }

    // --- Animations ---

    function sheet(pet, anim) {
        if (pet.images[anim]) return Promise.resolve(pet.images[anim])
        if (!pet.loading[anim]) {
            const image = new Image()
            image.src = `assets/images/pets/${pet.name}-${anim}.webp`
            pet.loading[anim] = image.decode().then(() => {
                pet.images[anim] = image
                return image
            }).finally(() => { delete pet.loading[anim] })
        }
        return pet.loading[anim]
    }
    async function play(pet, anim) {
        if (!running() || pet.anim === 'ultimate' || pet.anim === anim) return
        if (anim === 'ultimate' && pets.some(other => other.anim === 'ultimate' || other.pendingUltimate)) return
        if (anim === 'ultimate') pet.pendingUltimate = true
        try {
            await sheet(pet, anim)
        } catch (_error) {
            return // The idle loop simply carries on.
        } finally {
            pet.pendingUltimate = false
        }
        if (!running() || pet.anim === 'ultimate' || pet.anim === anim) return
        pet.anim = anim
        pet.start = elapsed
        pet.element.classList.toggle('isReacting', anim === 'pet')
        if (anim === 'ultimate') {
            pet.element.classList.add('isUltimate')
            hero.style.setProperty('--fx', getComputedStyle(pet.element).getPropertyValue('--pet'))
            hero.classList.add('isUltimate')
            // Leave the stage to this ultimate before the next autoplayed move.
            nextAction = Math.max(nextAction, elapsed + pet.meta.ultimate.duration * 1000 + 2500)
        }
    }
    function finish(pet) {
        if (pet.anim === 'ultimate') {
            hero.classList.remove('isUltimate')
            // Ultimates are the heaviest atlases: decode them again next time rather than keep them.
            delete pet.images.ultimate
        }
        pet.anim = 'idle'
        pet.element.classList.remove('isReacting', 'isUltimate')
    }
    // Keeps the scene alive when nobody touches it: a reaction every few seconds, an ultimate every third move.
    function direct() {
        if (elapsed < nextAction || !pets.length) return
        nextAction = elapsed + 6500 + Math.random() * 4000
        actionCount++
        if (actionCount % 3 === 2) {
            const name = ULTIMATE_ORDER[ultimateTurn++ % ULTIMATE_ORDER.length]
            const pet = pets.find(item => item.name === name)
            if (pet) play(pet, 'ultimate')
            return
        }
        const idle = pets.filter(pet => pet.anim === 'idle')
        if (idle.length) play(idle[Math.floor(Math.random() * idle.length)], 'pet')
    }

    // --- Setup ---

    let loaded = false
    function load() {
        if (loaded) return
        loaded = true
        stage.querySelectorAll('img.homePet').forEach(poster => {
            const name = poster.getAttribute('src').split('/').pop().replace('.png', '')
            const meta = require(`./assets/images/pets/${name}.json`)
            const pet = { name, meta, images: {}, loading: {}, anim: 'idle', start: 0, key: null }
            sheet(pet, 'idle').then(() => {
                mount(pet, poster)
                sheet(pet, 'pet').catch(() => {})
                sync()
            }).catch(() => {}) // On load failure, the static poster stays visible.
        })
    }
    function mount(pet, poster) {
        // Union of every animation's rect, in idle tiles: the canvas covers all of them.
        const rects = Object.values(pet.meta).map(meta => meta.rect)
        const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y))
        const w = Math.max(...rects.map(r => r.x + r.w)) - x, h = Math.max(...rects.map(r => r.y + r.h)) - y
        pet.bounds = { x, y, w, h }
        const tile = pet.meta.idle.width
        const label = NAMES[pet.name] || poster.alt

        const element = document.createElement('div')
        element.className = poster.className
        element.dataset.pet = pet.name
        element.innerHTML = '<div class="homePetFrame"><span class="homePetWave"></span><canvas></canvas><button type="button" class="homePetHit"></button><span class="homePetTag"><strong></strong><small>✦ Légendaire</small></span></div>'
        const canvas = element.querySelector('canvas')
        canvas.width = Math.round(w * tile)
        canvas.height = Math.round(h * tile)
        canvas.setAttribute('role', 'img')
        canvas.setAttribute('aria-label', label)
        Object.assign(canvas.style, { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` })
        // Fade only the edges that reach past the idle tile, so a clipped effect never ends on a hard line.
        const edge = (offset, size) => {
            const before = -offset / size * 100, after = (offset + size - 1) / size * 100
            return `transparent, #000 ${before * .6}%, #000 ${100 - after * .6}%, transparent`
        }
        canvas.style.maskImage = `linear-gradient(90deg, ${edge(x, w)}), linear-gradient(180deg, ${edge(y, h)})`
        canvas.style.maskComposite = 'intersect'
        element.querySelector('.homePetTag strong').textContent = label
        const hit = element.querySelector('.homePetHit')
        hit.setAttribute('aria-label', `${label} : lancer son ultime`)
        hit.addEventListener('pointerenter', () => play(pet, 'pet'))
        hit.addEventListener('click', () => play(pet, 'ultimate'))

        const context = canvas.getContext('2d')
        if (!context) return
        Object.assign(pet, { element, canvas, context })
        paint(pet, lowMotion())
        poster.replaceWith(element)
        pets.push(pet)
        pets.sort((a, b) => ULTIMATE_ORDER.indexOf(a.name) - ULTIMATE_ORDER.indexOf(b.name))
    }

    // Pet names in the collection strip wake the matching pet.
    landing.querySelectorAll('.homeCollection [data-pet]').forEach(chip => {
        const find = () => pets.find(pet => pet.name === chip.dataset.pet)
        chip.addEventListener('pointerenter', () => { const pet = find(); if (pet) play(pet, 'pet') })
        chip.addEventListener('click', () => { const pet = find(); if (pet) play(pet, 'ultimate') })
    })

    // --- Ambience: rising sparks, pointer spotlight and parallax ---

    const sparks = hero.querySelector('.homeSparks')
    const colors = ['#b0f65b', '#dcff9e', '#6fdcff', '#c68bff', '#ffe08a']
    for (let n = 0; n < 22; n++) {
        const spark = document.createElement('i')
        const duration = 6 + Math.random() * 7
        spark.style.cssText = `--x:${35 + Math.random() * 63}%;--s:${2 + Math.random() * 3}px;--d:${duration}s;--delay:${-Math.random() * duration}s;--drift:${(Math.random() - .5) * 60}px;--c:${colors[n % colors.length]}`
        sparks.appendChild(spark)
    }
    let pointer = null
    let pointerRequest = null
    hero.addEventListener('pointermove', event => {
        pointer = event
        if (pointerRequest == null) pointerRequest = requestAnimationFrame(() => {
            pointerRequest = null
            if (!running()) return
            const box = hero.getBoundingClientRect()
            const x = (pointer.clientX - box.left) / box.width, y = (pointer.clientY - box.top) / box.height
            hero.style.setProperty('--mx', `${x * 100}%`)
            hero.style.setProperty('--my', `${y * 100}%`)
            hero.style.setProperty('--px', (x - .5) * 2)
            hero.style.setProperty('--py', (y - .5) * 2)
        })
    })
    hero.addEventListener('pointerleave', () => ['--mx', '--my', '--px', '--py'].forEach(name => hero.style.removeProperty(name)))

    new IntersectionObserver(entries => {
        visible = entries[0].isIntersecting
        sync()
    }, { threshold: 0 }).observe(stage)
    new MutationObserver(sync).observe(landing, { attributes: true, attributeFilter: ['style', 'class'] })
    document.addEventListener('visibilitychange', sync)
    document.addEventListener('shop-visibility', sync)
    reducedMotion.addEventListener('change', sync)
})()
