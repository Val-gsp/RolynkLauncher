// Lecteur radio Rolynk (page d'accueil).
// Les mp3 du dossier app/assets/audio sont lus en blob : comme pour la vidéo,
// file:// ne gère pas les requêtes Range exigées par l'élément <audio>.
const _rFs = require('fs')
const _rPath = require('path')
const _rApp = require('@electron/remote').app
// Chargement défensif : si ConfigManager échoue à se charger ou à répondre pour une raison liée à
// la façon dont cette page est chargée (résolution de chemin, timing avec le script de préchargement
// qui l'initialise), la radio doit continuer à marcher sans persister le volume plutôt que de
// planter tout le lecteur -- une régression du réglage vaut mieux qu'une régression de la musique.
let ConfigManager = null
try {
    ConfigManager = require(_rPath.join(_rApp.getAppPath(), 'app', 'assets', 'js', 'configmanager'))
} catch (e) { /* pas de persistance du volume cette session */ }

function getSavedVolume(fallback) {
    try { return ConfigManager.getMusicVolume() } catch (e) { return fallback }
}

function saveVolume(v) {
    try { ConfigManager.setMusicVolume(v); ConfigManager.save() } catch (e) { /* tant pis */ }
}

;(function initRadio() {
    const audio = document.getElementById('radioAudio')
    const titleEl = document.getElementById('radioTitle')
    const playPauseBtn = document.getElementById('radioPlayPause')
    if (!audio || !titleEl || !playPauseBtn) return

    const audioDir = _rPath.join(_rApp.getAppPath(), 'app', 'assets', 'audio')
    let files = []
    try {
        files = _rFs.readdirSync(audioDir).filter(f => f.toLowerCase().endsWith('.mp3')).sort()
    } catch (e) { /* dossier absent */ }

    if (files.length === 0) { titleEl.textContent = 'Aucune musique'; return }

    const PLAY_ICON = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
    const PAUSE_ICON = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'

    let index = 0
    let currentUrl = null

    function cleanTitle(f) {
        return f.replace(/\.mp3$/i, '')
            .replace(/^RLK Radio\s*\[W\.C\.C\]\s*/i, '')
            .replace(/\s{2,}/g, ' — ')
            .trim()
    }

    function setPlayingIcon(playing) {
        playPauseBtn.innerHTML = playing ? PAUSE_ICON : PLAY_ICON
    }

    function load(i, autoplay) {
        index = ((i % files.length) + files.length) % files.length
        if (currentUrl) { window.URL.revokeObjectURL(currentUrl); currentUrl = null }
        try {
            const buf = _rFs.readFileSync(_rPath.join(audioDir, files[index]))
            currentUrl = window.URL.createObjectURL(new Blob([buf], { type: 'audio/mpeg' }))
            audio.src = currentUrl
            titleEl.textContent = cleanTitle(files[index])
            if (autoplay) audio.play().catch(() => {})
        } catch (e) {
            titleEl.textContent = 'Erreur de lecture'
        }
    }

    document.getElementById('radioPrev').onclick = () => load(index - 1, true)
    document.getElementById('radioNext').onclick = () => load(index + 1, true)
    playPauseBtn.onclick = () => {
        if (audio.paused) {
            if (!audio.src) load(index, true)
            else audio.play().catch(() => {})
        } else {
            audio.pause()
        }
    }

    // Réglage du volume : repris depuis la dernière valeur sauvegardée (0 inclus) plutôt que
    // depuis l'attribut value= statique du curseur. Persisté sur 'change' (fin d'interaction),
    // pas 'input' (déclenché en continu pendant qu'on glisse le curseur, inutile d'écrire à chaque
    // pixel), tandis que le volume audio lui-même reste appliqué en direct sur 'input'.
    const volSlider = document.getElementById('radioVolSlider')
    if (volSlider) {
        volSlider.value = getSavedVolume(Number(volSlider.value))
        audio.volume = volSlider.value / 100
        volSlider.addEventListener('input', () => { audio.volume = volSlider.value / 100 })
        volSlider.addEventListener('change', () => { saveVolume(Number(volSlider.value)) })
    }

    audio.addEventListener('play', () => setPlayingIcon(true))
    audio.addEventListener('pause', () => setPlayingIcon(false))
    audio.addEventListener('ended', () => load(index + 1, true))

    // Démarrage automatique de la radio.
    load(0, true)
    // Repli si l'autoplay est bloqué : démarre à la première interaction.
    const kick = () => {
        if (audio.paused) audio.play().catch(() => {})
        window.removeEventListener('click', kick)
        window.removeEventListener('keydown', kick)
    }
    window.addEventListener('click', kick)
    window.addEventListener('keydown', kick)
})()
