// Fond vidéo bouclé.
// Note : dans Electron, le protocole file:// ne gère pas les requêtes HTTP
// « Range » exigées par l'élément <video>, ce qui empêche la lecture directe
// (networkState reste à NO_SOURCE). On lit donc le fichier en mémoire et on le
// fournit via une URL blob, qui, elle, est lisible par le lecteur média.
const _bgFs = require('fs')
const _bgPath = require('path')
const _bgApp = require('@electron/remote').app

window.addEventListener('DOMContentLoaded', () => {
    const video = document.getElementById('bgVideo')
    if (!video) return
    try {
        const videoPath = _bgPath.join(_bgApp.getAppPath(), 'app', 'assets', 'videos', 'Rolynk_background.mp4')
        const buffer = _bgFs.readFileSync(videoPath)
        video.src = window.URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }))
        video.play().catch(() => { /* autoplay muet : rejet ignoré */ })
    } catch (err) {
        console.error('Fond vidéo : échec du chargement.', err)
    }
})
