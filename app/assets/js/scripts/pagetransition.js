/**
 * Page transition: the current page zooms into the center of the screen and fades
 * away, then the next page's blocks appear one after another.
 */
const ZOOM_OUT_MS = 300
const ZOOM_SCALE = 1.18
const APPEAR_MS = 360
const APPEAR_STAGGER_MS = 90
const APPEAR_MAX_PIECES = 40

const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
let pageTransitionQueue = Promise.resolve()

function prefersReducedMotion(){
    return reducedMotionQuery.matches
}

function visibleChildren(el){
    return [...el.children].filter(child => {
        if(child.tagName === 'SCRIPT' || child.tagName === 'STYLE') return false
        const style = getComputedStyle(child)
        if(style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
        const rect = child.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
    })
}

function hasOwnText(el){
    return [...el.childNodes].some(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim())
}

// Split a page into a handful of blocks so they can appear one after another.
function collectPagePieces(root){
    let pieces = visibleChildren(root)
    for(let depth = 0; depth < 2 && pieces.length < 6; depth++){
        pieces = pieces.flatMap(el => {
            if(hasOwnText(el)) return [el]
            const kids = visibleChildren(el)
            // Transforms don't apply to inline boxes, so keep those grouped with their parent.
            const splittable = kids.length > 1 && kids.every(k => getComputedStyle(k).display !== 'inline')
            return splittable ? kids : [el]
        })
    }
    return pieces.slice(0, APPEAR_MAX_PIECES)
}

function zoomIntoCenter(el){
    const main = document.getElementById('main').getBoundingClientRect()
    const rect = el.getBoundingClientRect()
    el.style.transformOrigin = `${main.left + main.width / 2 - rect.left}px ${main.top + main.height / 2 - rect.top}px`
    return el.animate([
        { transform: 'scale(1)', opacity: 1 },
        { transform: `scale(${ZOOM_SCALE})`, opacity: 0 }
    ], { duration: ZOOM_OUT_MS, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' })
}

function appearPieces(pieces){
    return pieces.map((el, i) => el.animate([
        { transform: 'scale(.97)', opacity: 0 },
        { transform: 'scale(1)', opacity: 1 }
    ], {
        duration: APPEAR_MS,
        delay: pieces.length > 1 ? i / (pieces.length - 1) * APPEAR_STAGGER_MS : 0,
        easing: 'cubic-bezier(.16,1,.3,1)',
        fill: 'backwards'
    }))
}

/**
 * Run a zoom transition between two containers. Transitions are queued so a new
 * one never starts while the previous one is still running.
 *
 * @param {Object} opts
 * @param {?Element} opts.from Container that zooms into the center and fades out.
 * @param {?Element} opts.to Container whose blocks appear once `swap` has run.
 * @param {Function} opts.swap Hides `from` and reveals `to`. May be async.
 * @returns {Promise<void>}
 */
function runPageTransition({ from, to, swap }){
    const task = pageTransitionQueue.then(async () => {
        if(prefersReducedMotion()){
            await swap()
            return
        }
        const main = document.getElementById('main')
        // The zoomed page overflows the window; without this, scrollbars flash during the zoom.
        main.classList.add('rlkPageTransitioning')
        try {
            const outgoing = from ? zoomIntoCenter(from) : null
            if(outgoing) await outgoing.finished
            try {
                await swap()
            } finally {
                if(outgoing){
                    outgoing.cancel()
                    from.style.transformOrigin = ''
                }
            }
            if(to){
                await Promise.all(appearPieces(collectPagePieces(to)).map(a => a.finished))
            }
        } finally {
            main.classList.remove('rlkPageTransitioning')
        }
    })
    pageTransitionQueue = task.catch(err => console.error('Page transition failed', err))
    return task
}
