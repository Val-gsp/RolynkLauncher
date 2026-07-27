/**
 * Script for landing.ejs
 */
// Requirements
// Note: `shell` is already declared globally by uicore.js (loaded earlier in app.ejs),
// re-declaring it here throws a SyntaxError and prevents this whole script from running.
const { URL }                 = require('url')
const { PAYMENT_OPCODE, DISCORD_OPCODE, DISCORD_REPLY_TYPE } = require('./assets/js/ipcconstants')
const {
    MojangRestAPI,
    getServerStatus
}                             = require('helios-core/mojang')
const {
    RestResponseStatus,
    isDisplayableError,
    validateLocalFile
}                             = require('helios-core/common')
const {
    FullRepair,
    DistributionIndexProcessor,
    MojangIndexProcessor,
    downloadFile
}                             = require('helios-core/dl')
const {
    validateSelectedJvm,
    ensureJavaDirIsRoot,
    javaExecFromRoot,
    discoverBestJvmInstallation,
    latestOpenJDK,
    extractJdk
}                             = require('helios-core/java')

// Internal Requirements
const DiscordWrapper          = require('./assets/js/discordwrapper')
const ProcessBuilder          = require('./assets/js/processbuilder')
const RolynkAuthClient        = require('./assets/js/rolynkauth')

// Launch Elements
const launch_content          = document.getElementById('launch_content')
const launch_details          = document.getElementById('launch_details')
const launch_progress         = document.getElementById('launch_progress')
const launch_progress_label   = document.getElementById('launch_progress_label')
const launch_details_text     = document.getElementById('launch_details_text')
const server_selection_button = document.getElementById('server_selection_button')
const user_text               = document.getElementById('user_text')

const loggerLanding = LoggerUtil.getLogger('Landing')

/* Launch Progress Wrapper Functions */

/**
 * Show/hide the loading area.
 * 
 * @param {boolean} loading True if the loading area should be shown, otherwise false.
 */
function toggleLaunchArea(loading){
    if(loading){
        launch_details.style.display = 'flex'
        launch_content.style.display = 'none'
    } else {
        launch_details.style.display = 'none'
        launch_content.style.display = 'inline-flex'
    }
}

/**
 * Set the details text of the loading area.
 * 
 * @param {string} details The new text for the loading details.
 */
function setLaunchDetails(details){
    launch_details_text.innerHTML = details
}

/**
 * Set the value of the loading progress bar and display that value.
 * 
 * @param {number} percent Percentage (0-100)
 */
function setLaunchPercentage(percent){
    launch_progress.setAttribute('max', 100)
    launch_progress.setAttribute('value', percent)
    launch_progress_label.innerHTML = percent + '%'
}

/**
 * Set the value of the OS progress bar and display that on the UI.
 * 
 * @param {number} percent Percentage (0-100)
 */
function setDownloadPercentage(percent){
    remote.getCurrentWindow().setProgressBar(percent/100)
    setLaunchPercentage(percent)
}

/**
 * Enable or disable the launch button.
 * 
 * @param {boolean} val True to enable, false to disable.
 */
function setLaunchEnabled(val){
    document.getElementById('launch_button').disabled = !val
}

// Bind launch button
document.getElementById('launch_button').addEventListener('click', async e => {
    loggerLanding.info('Launching game..')
    try {
        const server = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
        const jExe = ConfigManager.getJavaExecutable(ConfigManager.getSelectedServer())
        if(jExe == null){
            await asyncSystemScan(server.effectiveJavaOptions)
        } else {

            setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
            toggleLaunchArea(true)
            setLaunchPercentage(0, 100)

            const details = await validateSelectedJvm(ensureJavaDirIsRoot(jExe), server.effectiveJavaOptions.supported)
            if(details != null){
                loggerLanding.info('Jvm Details', details)
                await dlAsync()

            } else {
                await asyncSystemScan(server.effectiveJavaOptions)
            }
        }
    } catch(err) {
        loggerLanding.error('Unhandled error in during launch process.', err)
        showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), Lang.queryJS('landing.launch.failureText'))
    }
})

// Bind settings button
document.getElementById('settingsMediaButton').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings)
}

// Bind avatar overlay button.
document.getElementById('avatarOverlay').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
        settingsNavItemListener(document.getElementById('settingsNavAccount'), false)
    })
}

// Bind selected account
function updateSelectedAccount(authUser){
    let username = Lang.queryJS('landing.selectedAccount.noAccountSelected')
    if(authUser != null){
        if(authUser.displayName != null){
            username = authUser.displayName
        }
        if(authUser.uuid != null){
            document.getElementById('avatarContainer').style.backgroundImage = `url('https://mc-heads.net/body/${authUser.uuid}/right')`
        }
    }
    user_text.innerHTML = username
}
updateSelectedAccount(ConfigManager.getSelectedAccount())

// Bind selected server
function updateSelectedServer(serv){
    if(getCurrentView() === VIEWS.settings){
        fullSettingsSave()
    }
    ConfigManager.setSelectedServer(serv != null ? serv.rawServer.id : null)
    ConfigManager.save()
    server_selection_button.textContent = '• ' + (serv != null ? serv.rawServer.name : Lang.queryJS('landing.selectedServer.noSelection'))
    if(getCurrentView() === VIEWS.settings){
        animateSettingsTabRefresh()
    }
    setLaunchEnabled(serv != null)
}
// Real text is set in uibinder.js on distributionIndexDone.
server_selection_button.textContent = '• ' + Lang.queryJS('landing.selectedServer.loading')
server_selection_button.onclick = async e => {
    e.target.blur()
    await toggleServerSelection(true)
}

// Bouton latéral « Changer de serveur » : ouvre le même sélecteur d'instance.
const server_switch_button = document.getElementById('serverSwitchMediaButton')
if(server_switch_button){
    server_switch_button.onclick = async e => {
        e.currentTarget.blur()
        await toggleServerSelection(true)
    }
}

// Update Mojang Status Color
const refreshMojangStatuses = async function(){
    loggerLanding.info('Refreshing Mojang Statuses..')

    let status = 'grey'
    let tooltipEssentialHTML = ''
    let tooltipNonEssentialHTML = ''

    const response = await MojangRestAPI.status()
    let statuses
    if(response.responseStatus === RestResponseStatus.SUCCESS) {
        statuses = response.data
    } else {
        loggerLanding.warn('Unable to refresh Mojang service status.')
        statuses = MojangRestAPI.getDefaultStatuses()
    }
    
    greenCount = 0
    greyCount = 0

    for(let i=0; i<statuses.length; i++){
        const service = statuses[i]

        const tooltipHTML = `<div class="mojangStatusContainer">
            <span class="mojangStatusIcon" style="color: ${MojangRestAPI.statusToHex(service.status)};">&#8226;</span>
            <span class="mojangStatusName">${service.name}</span>
        </div>`
        if(service.essential){
            tooltipEssentialHTML += tooltipHTML
        } else {
            tooltipNonEssentialHTML += tooltipHTML
        }

        if(service.status === 'yellow' && status !== 'red'){
            status = 'yellow'
        } else if(service.status === 'red'){
            status = 'red'
        } else {
            if(service.status === 'grey'){
                ++greyCount
            }
            ++greenCount
        }

    }

    if(greenCount === statuses.length){
        if(greyCount === statuses.length){
            status = 'grey'
        } else {
            status = 'green'
        }
    }
    
    document.getElementById('mojangStatusEssentialContainer').innerHTML = tooltipEssentialHTML
    document.getElementById('mojangStatusNonEssentialContainer').innerHTML = tooltipNonEssentialHTML
    document.getElementById('mojang_status_icon').style.color = MojangRestAPI.statusToHex(status)
}

const refreshServerStatus = async (fade = false) => {
    loggerLanding.info('Refreshing Server Status')
    const serv = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())

    let pLabel = Lang.queryJS('landing.serverStatus.server')
    let pVal = Lang.queryJS('landing.serverStatus.offline')

    try {

        const servStat = await getServerStatus(47, serv.hostname, serv.port)
        console.log(servStat)
        pLabel = Lang.queryJS('landing.serverStatus.players')
        pVal = servStat.players.online + '/' + servStat.players.max

    } catch (err) {
        loggerLanding.warn('Unable to refresh server status, assuming offline.')
        loggerLanding.debug(err)
    }
    if(fade){
        $('#server_status_wrapper').fadeOut(250, () => {
            document.getElementById('landingPlayerLabel').innerHTML = pLabel
            document.getElementById('player_count').innerHTML = pVal
            $('#server_status_wrapper').fadeIn(500)
        })
    } else {
        document.getElementById('landingPlayerLabel').innerHTML = pLabel
        document.getElementById('player_count').innerHTML = pVal
    }
    
}

refreshMojangStatuses()
// Server Status is refreshed in uibinder.js on distributionIndexDone.

// Refresh statuses every hour. The status page itself refreshes every day so...
let mojangStatusListener = setInterval(() => refreshMojangStatuses(true), 60*60*1000)
// Set refresh rate to once every 5 minutes.
let serverStatusListener = setInterval(() => refreshServerStatus(true), 300000)

/**
 * Shows an error overlay, toggles off the launch area.
 * 
 * @param {string} title The overlay title.
 * @param {string} desc The overlay description.
 */
function showLaunchFailure(title, desc){
    setOverlayContent(
        title,
        desc,
        Lang.queryJS('landing.launch.okay')
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false)
}

/**
 * Vérifie (et si besoin, propose) la liaison Discord obligatoire pour un compte
 * premium avant de lancer le jeu. Réutilise l'overlay générique du launcher et
 * le même mécanisme IPC de fenêtre OAuth Discord que les comptes crack
 * (DISCORD_OPCODE.OPEN_LINK / REPLY_LINK, géré côté process principal dans
 * index.js — aucune modification nécessaire là-bas).
 *
 * @param {Object} authUser Le compte premium sélectionné (ConfigManager).
 * @returns {Promise.<boolean>} true si le compte est lié et prêt à jouer.
 */
function ensurePremiumDiscordLinked(authUser){
    return new Promise((resolve) => {
        RolynkAuthClient.premiumLinkStatus(authUser.uuid, authUser.displayName)
            .then(({ status, data }) => {
                if(status === 200 && data && data.ok && data.status === 'active') {
                    resolve(true)
                    return
                }
                if(status === 200 && data && data.ok && data.status === 'banned') {
                    showLaunchFailure(Lang.queryJS('landing.discordGate.bannedTitle'), Lang.queryJS('landing.discordGate.bannedDesc'))
                    resolve(false)
                    return
                }
                if(!(status === 200 && data && data.ok && data.discord_auth_url)) {
                    showLaunchFailure(Lang.queryJS('landing.discordGate.errorTitle'), Lang.queryJS('landing.discordGate.errorDesc'))
                    resolve(false)
                    return
                }

                // Compte en attente de liaison : propose d'ouvrir la fenêtre Discord.
                setOverlayContent(
                    Lang.queryJS('landing.discordGate.requiredTitle'),
                    Lang.queryJS('landing.discordGate.requiredDesc'),
                    Lang.queryJS('landing.discordGate.linkButton'),
                    Lang.queryJS('landing.discordGate.cancelButton')
                )
                setOverlayHandler(() => {
                    toggleOverlay(false)
                    ipcRenderer.send(DISCORD_OPCODE.OPEN_LINK, data.discord_auth_url)
                })
                setDismissHandler(() => {
                    toggleOverlay(false, true)
                    resolve(false)
                })
                toggleOverlay(true, true)

                const onReply = (_, type) => {
                    ipcRenderer.removeListener(DISCORD_OPCODE.REPLY_LINK, onReply)
                    if(type === DISCORD_REPLY_TYPE.SUCCESS) {
                        resolve(true)
                    } else {
                        setOverlayContent(
                            Lang.queryJS('landing.discordGate.cancelledTitle'),
                            Lang.queryJS('landing.discordGate.cancelledDesc'),
                            Lang.queryJS('landing.launch.okay')
                        )
                        setOverlayHandler(() => toggleOverlay(false))
                        toggleOverlay(true)
                        resolve(false)
                    }
                }
                ipcRenderer.on(DISCORD_OPCODE.REPLY_LINK, onReply)
            })
            .catch((err) => {
                loggerLanding.error('Échec de la vérification de liaison Discord (premium).', err)
                showLaunchFailure(Lang.queryJS('landing.discordGate.errorTitle'), Lang.queryJS('landing.discordGate.errorDesc'))
                resolve(false)
            })
    })
}

/**
 * Code à usage temporaire envoyé par Discord, exigé à CHAQUE tentative de
 * lancement sur les serveurs `requiresDiscord` (Rolynk V1), pour les comptes
 * premium ET crack. Distinct de ensurePremiumDiscordLinked : celle-ci ne
 * vérifie qu'un statut "lié" une fois, ceci redemande un code à chaque fois.
 *
 * @param {string} accountType 'premium' ou 'crack'
 * @param {string} uuid
 * @param {string} username
 * @returns {Promise.<boolean>} true si un code valide a été saisi.
 */
function ensureLaunchOtp(accountType, uuid, username){
    return new Promise((resolve) => {
        RolynkAuthClient.requestLaunchOtp(accountType, uuid, username)
            .then(({ status, data }) => {
                if(!(status === 200 && data && data.ok && data.challenge_id)) {
                    showLaunchFailure(Lang.queryJS('landing.launchOtp.errorTitle'), Lang.queryJS('landing.launchOtp.errorDesc'))
                    resolve(false)
                    return
                }
                promptOtpCode(data.challenge_id, resolve)
            })
            .catch((err) => {
                loggerLanding.error('Échec de la demande de code Discord (V1).', err)
                showLaunchFailure(Lang.queryJS('landing.launchOtp.errorTitle'), Lang.queryJS('landing.launchOtp.errorDesc'))
                resolve(false)
            })
    })
}

/** Affiche l'overlay de saisie du code (réutilise l'overlay générique, un
 * champ de saisie est injecté dans la description — overlayDesc utilise
 * innerHTML). Se ré-affiche avec un message d'erreur en cas de code invalide,
 * plutôt que de fermer/rouvrir un panneau dédié. */
function promptOtpCode(challengeId, resolve, errorMessage){
    const errorHtml = errorMessage
        ? `<div style="color:#ff6b6b;margin-top:0.5rem;font-size:0.85rem">${errorMessage}</div>` : ''
    const desc = `${Lang.queryJS('landing.launchOtp.desc')}<br><br>`
        + '<input id="launchOtpInput" type="text" inputmode="numeric" maxlength="6" placeholder="000000" '
        + 'style="width:100%;text-align:center;font-size:1.4rem;letter-spacing:0.3rem;padding:0.5rem;'
        + 'border-radius:6px;border:1px solid #444;background:#1b1b1b;color:#fff;margin-top:0.5rem;">'
        + errorHtml

    setOverlayContent(
        Lang.queryJS('landing.launchOtp.title'),
        desc,
        Lang.queryJS('landing.launchOtp.button'),
        Lang.queryJS('landing.discordGate.cancelButton')
    )
    setOverlayHandler(async () => {
        const input = document.getElementById('launchOtpInput')
        const code = input ? input.value.trim() : ''
        if(!/^[0-9]{6}$/.test(code)) {
            promptOtpCode(challengeId, resolve, Lang.queryJS('landing.launchOtp.errorFormat'))
            return
        }
        try {
            const { status, data } = await RolynkAuthClient.verifyLaunchOtp(challengeId, code)
            if(status === 200 && data && data.ok) {
                toggleOverlay(false)
                resolve(true)
            } else {
                promptOtpCode(challengeId, resolve, Lang.queryJS('landing.launchOtp.errorCode'))
            }
        } catch(err) {
            promptOtpCode(challengeId, resolve, Lang.queryJS('landing.launchOtp.errorNetwork'))
        }
    })
    setDismissHandler(() => {
        toggleOverlay(false, true)
        resolve(false)
    })
    toggleOverlay(true, true)
}

/* System (Java) Scan */

/**
 * Asynchronously scan the system for valid Java installations.
 * 
 * @param {boolean} launchAfter Whether we should begin to launch after scanning. 
 */
async function asyncSystemScan(effectiveJavaOptions, launchAfter = true){

    setLaunchDetails(Lang.queryJS('landing.systemScan.checking'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const jvmDetails = await discoverBestJvmInstallation(
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.supported
    )

    if(jvmDetails == null) {
        // If the result is null, no valid Java installation was found.
        // Show this information to the user.
        setOverlayContent(
            Lang.queryJS('landing.systemScan.noCompatibleJava'),
            Lang.queryJS('landing.systemScan.installJavaMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
            Lang.queryJS('landing.systemScan.installJava'),
            Lang.queryJS('landing.systemScan.installJavaManually')
        )
        setOverlayHandler(() => {
            setLaunchDetails(Lang.queryJS('landing.systemScan.javaDownloadPrepare'))
            toggleOverlay(false)
            
            try {
                downloadJava(effectiveJavaOptions, launchAfter)
            } catch(err) {
                loggerLanding.error('Unhandled error in Java Download', err)
                showLaunchFailure(Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'), Lang.queryJS('landing.systemScan.javaDownloadFailureText'))
            }
        })
        setDismissHandler(() => {
            $('#overlayContent').fadeOut(250, () => {
                //$('#overlayDismiss').toggle(false)
                setOverlayContent(
                    Lang.queryJS('landing.systemScan.javaRequired', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredDismiss'),
                    Lang.queryJS('landing.systemScan.javaRequiredCancel')
                )
                setOverlayHandler(() => {
                    toggleLaunchArea(false)
                    toggleOverlay(false)
                })
                setDismissHandler(() => {
                    toggleOverlay(false, true)

                    asyncSystemScan(effectiveJavaOptions, launchAfter)
                })
                $('#overlayContent').fadeIn(250)
            })
        })
        toggleOverlay(true, true)
    } else {
        // Java installation found, use this to launch the game.
        const javaExec = javaExecFromRoot(jvmDetails.path)
        ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), javaExec)
        ConfigManager.save()

        // We need to make sure that the updated value is on the settings UI.
        // Just incase the settings UI is already open.
        settingsJavaExecVal.value = javaExec
        await populateJavaExecDetails(settingsJavaExecVal.value)

        // TODO Callback hell, refactor
        // TODO Move this out, separate concerns.
        if(launchAfter){
            await dlAsync()
        }
    }

}

async function downloadJava(effectiveJavaOptions, launchAfter = true) {

    // TODO Error handling.
    // asset can be null.
    const asset = await latestOpenJDK(
        effectiveJavaOptions.suggestedMajor,
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.distribution)

    if(asset == null) {
        throw new Error(Lang.queryJS('landing.downloadJava.findJdkFailure'))
    }

    let received = 0
    await downloadFile(asset.url, asset.path, ({ transferred }) => {
        received = transferred
        setDownloadPercentage(Math.trunc((transferred/asset.size)*100))
    })
    setDownloadPercentage(100)

    if(received != asset.size) {
        loggerLanding.warn(`Java Download: Expected ${asset.size} bytes but received ${received}`)
        if(!await validateLocalFile(asset.path, asset.algo, asset.hash)) {
            log.error(`Hashes do not match, ${asset.id} may be corrupted.`)
            // Don't know how this could happen, but report it.
            throw new Error(Lang.queryJS('landing.downloadJava.javaDownloadCorruptedError'))
        }
    }

    // Extract
    // Show installing progress bar.
    remote.getCurrentWindow().setProgressBar(2)

    // Wait for extration to complete.
    const eLStr = Lang.queryJS('landing.downloadJava.extractingJava')
    let dotStr = ''
    setLaunchDetails(eLStr)
    const extractListener = setInterval(() => {
        if(dotStr.length >= 3){
            dotStr = ''
        } else {
            dotStr += '.'
        }
        setLaunchDetails(eLStr + dotStr)
    }, 750)

    const newJavaExec = await extractJdk(asset.path)

    // Extraction complete, remove the loading from the OS progress bar.
    remote.getCurrentWindow().setProgressBar(-1)

    // Extraction completed successfully.
    ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), newJavaExec)
    ConfigManager.save()

    clearInterval(extractListener)
    setLaunchDetails(Lang.queryJS('landing.downloadJava.javaInstalled'))

    // TODO Callback hell
    // Refactor the launch functions
    asyncSystemScan(effectiveJavaOptions, launchAfter)

}

// Keep reference to Minecraft Process
let proc
// Is DiscordRPC enabled
let hasRPC = false
// Joined server regex
// Change this if your server uses something different.
const GAME_JOINED_REGEX = /\[.+\]: Sound engine started/
const GAME_LAUNCH_REGEX = /^\[.+\]: (?:MinecraftForge .+ Initialized|ModLauncher .+ starting: .+|Loading Minecraft .+ with Fabric Loader .+)$/
const MIN_LINGER = 5000

async function dlAsync(login = true) {

    // Login parameter is temporary for debug purposes. Allows testing the validation/downloads without
    // launching the game.

    const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')

    setLaunchDetails(Lang.queryJS('landing.dlAsync.loadingServerInfo'))

    let distro

    try {
        distro = await DistroAPI.refreshDistributionOrFallback()
        onDistroRefresh(distro)
    } catch(err) {
        loggerLaunchSuite.error('Unable to refresh distribution index.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.fatalError'), Lang.queryJS('landing.dlAsync.unableToLoadDistributionIndex'))
        return
    }

    const serv = distro.getServerById(ConfigManager.getSelectedServer())

    if(login) {
        if(ConfigManager.getSelectedAccount() == null){
            loggerLanding.error('You must be logged into an account.')
            return
        }

        const preLaunchAccount = ConfigManager.getSelectedAccount()
        // Seuls les serveurs marqués requiresDiscord (Rolynk V1, voir
        // tools/gen-distro.js) exigent quoi que ce soit ici pour les comptes
        // premium. Rolynk (beta) : connexion premium directe, sans changement.
        const requiresDiscord = !!(serv && serv.rawServer && serv.rawServer.requiresDiscord)

        // Liaison Discord (une fois) pour les comptes premium — uniquement sur
        // les serveurs requiresDiscord. Les comptes crack sont déjà garantis
        // liés avant même d'être persistés (voir rolynkauth.js / rkOnAuthSuccess),
        // sur TOUS les serveurs : ce n'est pas propre à requiresDiscord.
        if(requiresDiscord && preLaunchAccount.type === 'microsoft') {
            const linked = await ensurePremiumDiscordLinked(preLaunchAccount)
            if(!linked) {
                return
            }
        }

        // Code Discord à usage temporaire, exigé à CHAQUE connexion sur les
        // serveurs requiresDiscord — pour les comptes premium ET crack.
        if(requiresDiscord && (preLaunchAccount.type === 'microsoft' || preLaunchAccount.type === 'rolynk')) {
            const accountType = preLaunchAccount.type === 'microsoft' ? 'premium' : 'crack'
            const otpOk = await ensureLaunchOtp(accountType, preLaunchAccount.uuid, preLaunchAccount.displayName)
            if(!otpOk) {
                return
            }
        }
    }

    setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const fullRepairModule = new FullRepair(
        ConfigManager.getCommonDirectory(),
        ConfigManager.getInstanceDirectory(),
        ConfigManager.getLauncherDirectory(),
        ConfigManager.getSelectedServer(),
        DistroAPI.isDevMode()
    )

    fullRepairModule.spawnReceiver()

    fullRepairModule.childProcess.on('error', (err) => {
        loggerLaunchSuite.error('Error during launch', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), err.message || Lang.queryJS('landing.dlAsync.errorDuringLaunchText'))
    })
    fullRepairModule.childProcess.on('close', (code, _signal) => {
        if(code !== 0){
            loggerLaunchSuite.error(`Full Repair Module exited with code ${code}, assuming error.`)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        }
    })

    loggerLaunchSuite.info('Validating files.')
    setLaunchDetails(Lang.queryJS('landing.dlAsync.validatingFileIntegrity'))
    let invalidFileCount = 0
    try {
        invalidFileCount = await fullRepairModule.verifyFiles(percent => {
            setLaunchPercentage(percent)
        })
        setLaunchPercentage(100)
    } catch (err) {
        loggerLaunchSuite.error('Error during file validation.')
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        return
    }
    

    if(invalidFileCount > 0) {
        loggerLaunchSuite.info('Downloading files.')
        setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'))
        setLaunchPercentage(0)
        try {
            await fullRepairModule.download(percent => {
                setDownloadPercentage(percent)
            })
            setDownloadPercentage(100)
        } catch(err) {
            loggerLaunchSuite.error('Error during file download.')
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), err.displayable || Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
            return
        }
    } else {
        loggerLaunchSuite.info('No invalid files, skipping download.')
    }

    // Remove download bar.
    remote.getCurrentWindow().setProgressBar(-1)

    fullRepairModule.destroyReceiver()

    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'))

    const mojangIndexProcessor = new MojangIndexProcessor(
        ConfigManager.getCommonDirectory(),
        serv.rawServer.minecraftVersion)
    const distributionIndexProcessor = new DistributionIndexProcessor(
        ConfigManager.getCommonDirectory(),
        distro,
        serv.rawServer.id
    )

    const modLoaderData = await distributionIndexProcessor.loadModLoaderVersionJson(serv)
    const versionData = await mojangIndexProcessor.getVersionJson()

    if(login) {
        const authUser = ConfigManager.getSelectedAccount()
        loggerLaunchSuite.info(`Sending selected account (${authUser.displayName}) to ProcessBuilder.`)

        // Compte crack Rolynk : armer la connexion transparente (pont jeton v2).
        // Non bloquant : en cas d'échec (jeton expiré, endpoint absent), le joueur
        // devra simplement faire /login en jeu (repli v1).
        if(authUser.type === 'rolynk') {
            try {
                const rolynkToken = RolynkAuthClient.getAccountToken(authUser)
                if(rolynkToken) {
                    const res = await RolynkAuthClient.armGameSession(rolynkToken)
                    if(res.status === 200 && res.data.ok) {
                        loggerLaunchSuite.info('Session de jeu Rolynk armée (connexion transparente).')
                    } else {
                        loggerLaunchSuite.warn('Session de jeu Rolynk non armée, repli sur /login en jeu.', res.status)
                    }
                }
            } catch(err) {
                loggerLaunchSuite.warn('Échec de l\'armement de la session de jeu Rolynk, repli sur /login en jeu.', err)
            }
        }

        let pb = new ProcessBuilder(serv, versionData, modLoaderData, authUser, remote.app.getVersion())
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingGame'))

        // const SERVER_JOINED_REGEX = /\[.+\]: \[CHAT\] [a-zA-Z0-9_]{1,16} joined the game/
        const SERVER_JOINED_REGEX = new RegExp(`\\[.+\\]: \\[CHAT\\] ${authUser.displayName} joined the game`)

        const onLoadComplete = () => {
            toggleLaunchArea(false)
            if(hasRPC){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.loading'))
                proc.stdout.on('data', gameStateChange)
            }
            proc.stdout.removeListener('data', tempListener)
            proc.stderr.removeListener('data', gameErrorListener)
        }
        const start = Date.now()

        // Attach a temporary listener to the client output.
        // Will wait for a certain bit of text meaning that
        // the client application has started, and we can hide
        // the progress bar stuff.
        const tempListener = function(data){
            if(GAME_LAUNCH_REGEX.test(data.trim())){
                const diff = Date.now()-start
                if(diff < MIN_LINGER) {
                    setTimeout(onLoadComplete, MIN_LINGER-diff)
                } else {
                    onLoadComplete()
                }
            }
        }

        // Listener for Discord RPC.
        const gameStateChange = function(data){
            data = data.trim()
            if(SERVER_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joined'))
            } else if(GAME_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joining'))
            }
        }

        const gameErrorListener = function(data){
            data = data.trim()
            if(data.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1){
                loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.launchWrapperNotDownloaded'))
            }
        }

        try {
            // Build Minecraft process.
            proc = pb.build()

            // Bind listeners to stdout.
            proc.stdout.on('data', tempListener)
            proc.stderr.on('data', gameErrorListener)

            setLaunchDetails(Lang.queryJS('landing.dlAsync.doneEnjoyServer'))

            // Init Discord Hook
            if(distro.rawDistribution.discord != null && serv.rawServer.discord != null){
                DiscordWrapper.initRPC(distro.rawDistribution.discord, serv.rawServer.discord)
                hasRPC = true
                proc.on('close', (code, signal) => {
                    loggerLaunchSuite.info('Shutting down Discord Rich Presence..')
                    DiscordWrapper.shutdownRPC()
                    hasRPC = false
                    proc = null
                })
            }

        } catch(err) {

            loggerLaunchSuite.error('Error during launch', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.checkConsoleForDetails'))

        }
    }

}

/**
 * Shop Panel Functions
 */

// Shop slide caches.
let shopActive = false
let shopGlideCount = 0

/**
 * Show the shop UI via a slide animation.
 *
 * @param {boolean} up True to slide up, otherwise false.
 */
function slide_(up){
    const lCUpper = document.querySelector('#landingContainer > #upper')
    const lCLLeft = document.querySelector('#landingContainer > #lower > #left')
    const lCLCenter = document.querySelector('#landingContainer > #lower > #center')
    const lCLRight = document.querySelector('#landingContainer > #lower > #right')
    const shopBtn = document.querySelector('#landingContainer > #lower > #center #content')
    const landingContainer = document.getElementById('landingContainer')
    const shopContainer = document.querySelector('#landingContainer > #shopContainer')

    shopGlideCount++

    if(up){
        lCUpper.style.top = '-200vh'
        lCLLeft.style.top = '-200vh'
        lCLCenter.style.top = '-200vh'
        lCLRight.style.top = '-200vh'
        shopBtn.style.top = '130vh'
        shopContainer.style.top = '0px'
        landingContainer.style.background = 'rgba(0, 0, 0, 0.50)'
        setTimeout(() => {
            if(shopGlideCount === 1){
                lCLCenter.style.transition = 'none'
                shopBtn.style.transition = 'none'
            }
            shopGlideCount--
        }, 2000)
    } else {
        setTimeout(() => {
            shopGlideCount--
        }, 2000)
        landingContainer.style.background = null
        lCLCenter.style.transition = null
        shopBtn.style.transition = null
        shopContainer.style.top = '100%'
        lCUpper.style.top = '0px'
        lCLLeft.style.top = '0px'
        lCLCenter.style.top = '0px'
        lCLRight.style.top = '0px'
        shopBtn.style.top = '10px'
    }
}

/**
 * Toggle the shop panel open or closed, managing tab focus accordingly.
 */
function toggleShop(){
    // Toggle tabbing.
    if(shopActive){
        $('#landingContainer *').removeAttr('tabindex')
        $('#shopContainer *').attr('tabindex', '-1')
    } else {
        $('#landingContainer *').attr('tabindex', '-1')
        $('#shopContainer, #shopContainer *, #lower, #lower #center *').removeAttr('tabindex')
    }
    slide_(!shopActive)
    shopActive = !shopActive
    // Hide the floating radio player while the shop covers the screen.
    document.getElementById('landingContainer').classList.toggle('shopOpen', shopActive)
    if(shopActive){
        // Wait for the slide-up animation before measuring, otherwise the grid
        // may still report its pre-layout (hidden) size.
        setTimeout(updateShopGridScrollHint, 250)
    }
}

/**
 * Show a "scroll for more" hint at the bottom of the pack grid when it
 * overflows and isn't already scrolled to the bottom, so a cropped card
 * reads as scrollable rather than broken.
 */
function updateShopGridScrollHint(){
    const grid = document.getElementById('shopGrid')
    const hint = document.getElementById('shopGridScrollHint')
    const hasMore = grid.scrollHeight - grid.scrollTop - grid.clientHeight > 4
    hint.classList.toggle('shopGridScrollHintVisible', hasMore)
}
document.getElementById('shopGrid').addEventListener('scroll', updateShopGridScrollHint)
window.addEventListener('resize', () => { if(shopActive) updateShopGridScrollHint() })

// Bind shop button.
document.getElementById('shopButton').onclick = () => {
    toggleShop()
}

// Bind shop close button.
document.getElementById('shopCloseButton').onclick = () => {
    toggleShop()
}

/**
 * Add keyboard controls to the shop UI. If you are on the landing page,
 * the up arrow will open the shop UI.
 */
document.addEventListener('keydown', (e) => {
    if(!shopActive){
        if(getCurrentView() === VIEWS.landing){
            if(e.key === 'ArrowUp'){
                document.getElementById('shopButton').click()
            }
        }
    }
})

/**
 * Legal Panel (Mentions légales / CGV / Confidentialité)
 */

const legalContainer = document.getElementById('legalContainer')

function openLegalDoc(doc){
    document.querySelectorAll('.legalTab').forEach(el => {
        el.classList.toggle('legalTabActive', el.getAttribute('data-legal-doc') === doc)
    })
    document.querySelectorAll('.legalDoc').forEach(el => {
        el.style.display = el.getAttribute('data-legal-doc') === doc ? 'block' : 'none'
    })
    document.getElementById('legalContent').scrollTop = 0
    legalContainer.classList.add('legalOpen')
}

document.querySelectorAll('.legalTab').forEach(el => {
    el.onclick = () => openLegalDoc(el.getAttribute('data-legal-doc'))
})
document.querySelectorAll('.shopPolicyLink').forEach(el => {
    el.onclick = () => openLegalDoc(el.getAttribute('data-legal-doc'))
})
document.getElementById('legalCloseButton').onclick = () => {
    legalContainer.classList.remove('legalOpen')
}
legalContainer.onclick = (e) => {
    if(e.target === legalContainer){
        legalContainer.classList.remove('legalOpen')
    }
}

/**
 * Pre-checkout consent (CGV + right of withdrawal waiver) shown before
 * creating a Stripe Checkout session and redirecting to it.
 */

// Base URL of the Rolynk payment backend (deployed separately, directly on
// the OVH server — not part of this repo). Live in test mode as of writing
// (confirmed reachable at /health). Override via
// window.ROLYNK_PAYMENT_API_BASE for local/dev testing against a different
// instance without touching this file.
const PAYMENT_API_BASE = window.ROLYNK_PAYMENT_API_BASE || 'https://shop.rolynk.fr'

const checkoutConsentContainer = document.getElementById('checkoutConsentContainer')
const checkoutConsentCGV        = document.getElementById('checkoutConsentCGV')
const checkoutConsentWithdrawal = document.getElementById('checkoutConsentWithdrawal')
const checkoutConsentContinue   = document.getElementById('checkoutConsentContinue')
const checkoutConsentError      = document.getElementById('checkoutConsentError')

let pendingItemId = null
let checkoutInFlight = false

function updateCheckoutConsentState(){
    checkoutConsentContinue.disabled = checkoutInFlight || !(checkoutConsentCGV.checked && checkoutConsentWithdrawal.checked)
}
checkoutConsentCGV.onchange = updateCheckoutConsentState
checkoutConsentWithdrawal.onchange = updateCheckoutConsentState

function setCheckoutConsentError(message){
    if(message){
        checkoutConsentError.textContent = message
        checkoutConsentError.style.display = 'block'
    } else {
        checkoutConsentError.style.display = 'none'
    }
}

function openCheckoutConsent(itemId){
    pendingItemId = itemId
    checkoutConsentCGV.checked = false
    checkoutConsentWithdrawal.checked = false
    setCheckoutConsentError(null)
    updateCheckoutConsentState()
    checkoutConsentContainer.classList.add('checkoutConsentOpen')
}

function closeCheckoutConsent(){
    pendingItemId = null
    checkoutConsentContainer.classList.remove('checkoutConsentOpen')
}

document.querySelectorAll('.shopCardBuy').forEach(btn => {
    const itemId = btn.getAttribute('data-pack-id')
    btn.onclick = (e) => {
        e.preventDefault()
        if(itemId){
            openCheckoutConsent(itemId)
        }
    }
})

document.getElementById('checkoutConsentCancel').onclick = () => {
    if(!checkoutInFlight){
        closeCheckoutConsent()
    }
}
checkoutConsentContainer.onclick = (e) => {
    if(e.target === checkoutConsentContainer && !checkoutInFlight){
        closeCheckoutConsent()
    }
}

// Maps the payment backend's { error: "<code>" } responses to a friendly,
// localized message. Falls back to a generic message for unknown codes so a
// backend-side addition never surfaces raw error codes to a player.
const CHECKOUT_ERROR_MESSAGES = {
    uuid_invalide: 'landing.checkout.errorInvalidUuid',
    item_inconnu: 'landing.checkout.errorUnknownItem',
    stripe_indisponible: 'landing.checkout.errorStripeUnavailable'
}

// Tracks the Stripe Checkout session this launcher instance actually
// opened, so the rolynk://payment-success deep link can be verified before
// showing a "payment confirmed" popup. Without this, any local process or
// web page could trigger rolynk://payment-success?item=prestige and get a
// convincing (but fake) confirmation popup, since the deep link itself
// grants nothing server-side -- it's purely a UI signal. Stored in
// localStorage (not a plain variable) so it survives the app being closed
// and relaunched by the OS while the player is still on the Stripe page.
const PENDING_CHECKOUT_STORAGE_KEY = 'rolynkPendingCheckout'
const PENDING_CHECKOUT_MAX_AGE_MS = 2 * 60 * 60 * 1000 // 2h, well over any realistic checkout duration

function rememberPendingCheckout(checkoutUrl, itemId){
    const match = typeof checkoutUrl === 'string' && checkoutUrl.match(/cs_(?:test|live)_[A-Za-z0-9]+/)
    if(!match){
        loggerLanding.warn('Could not extract a Stripe session id from checkout URL; payment-success deep link will not be able to verify this purchase.')
        localStorage.removeItem(PENDING_CHECKOUT_STORAGE_KEY)
        return
    }
    localStorage.setItem(PENDING_CHECKOUT_STORAGE_KEY, JSON.stringify({
        sessionId: match[0],
        itemId,
        createdAt: Date.now()
    }))
}

// Validates a rolynk://payment-success?session_id=...&item=... deep link
// against the session id we stored when we opened the checkout ourselves.
// Returns the verified itemId (preferring our own record over the one in
// the URL) on success, or null if the deep link can't be verified -- in
// which case the caller must NOT show a success confirmation.
function consumeVerifiedPendingCheckout(sessionIdFromLink){
    const raw = localStorage.getItem(PENDING_CHECKOUT_STORAGE_KEY)
    localStorage.removeItem(PENDING_CHECKOUT_STORAGE_KEY) // single use either way

    if(!raw || !sessionIdFromLink){
        return null
    }

    let stored
    try {
        stored = JSON.parse(raw)
    } catch (err) {
        return null
    }

    if(stored == null || stored.sessionId !== sessionIdFromLink){
        return null
    }
    if(typeof stored.createdAt !== 'number' || (Date.now() - stored.createdAt) > PENDING_CHECKOUT_MAX_AGE_MS){
        return null
    }

    return stored.itemId || null
}

checkoutConsentContinue.onclick = async () => {
    if(checkoutConsentContinue.disabled || pendingItemId == null){
        return
    }

    const account = ConfigManager.getSelectedAccount()
    if(account == null){
        setCheckoutConsentError(Lang.queryJS('landing.checkout.noAccountError'))
        return
    }

    checkoutInFlight = true
    updateCheckoutConsentState()
    setCheckoutConsentError(null)
    const originalLabel = checkoutConsentContinue.textContent
    checkoutConsentContinue.textContent = Lang.queryJS('landing.checkout.continueLoading')

    try {
        const res = await fetch(`${PAYMENT_API_BASE}/checkout/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                itemId: pendingItemId,
                uuid: account.uuid,
                pseudo: account.displayName
            })
        })

        const data = await res.json().catch(() => null)

        if(!res.ok){
            const langKey = data && CHECKOUT_ERROR_MESSAGES[data.error]
            throw new Error(langKey ? Lang.queryJS(langKey) : `HTTP ${res.status}`)
        }
        if(!data || !data.url){
            throw new Error('Missing checkout URL in response')
        }

        rememberPendingCheckout(data.url, pendingItemId)
        shell.openExternal(data.url)
        closeCheckoutConsent()
        showPaymentResult('pending')
    } catch (err) {
        loggerLanding.error('Failed to create checkout session', err)
        // If err.message is already one of our localized strings (set
        // above from a known error code), show it as-is; otherwise fall
        // back to the generic message rather than leaking raw details.
        const isKnownMessage = Object.values(CHECKOUT_ERROR_MESSAGES).some(key => Lang.queryJS(key) === err.message)
        setCheckoutConsentError(isKnownMessage ? err.message : Lang.queryJS('landing.checkout.genericError'))
    } finally {
        checkoutInFlight = false
        checkoutConsentContinue.textContent = originalLabel
        updateCheckoutConsentState()
    }
}

/**
 * Payment result popup, shown once the player returns from the Stripe
 * checkout page. Triggered by a rolynk://payment-success|payment-cancel
 * deep link (see index.js), which the payment provider's success/cancel
 * page opens after the browser flow completes.
 */

const paymentResultContainer   = document.getElementById('paymentResultContainer')
const paymentResultPanel       = document.getElementById('paymentResultPanel')
const paymentResultTitle       = document.getElementById('paymentResultTitle')
const paymentResultMessage     = document.getElementById('paymentResultMessage')
const paymentResultClose       = document.getElementById('paymentResultClose')
const paymentResultIcons = {
    success: document.getElementById('paymentResultIconSuccess'),
    cancel: document.getElementById('paymentResultIconCancel'),
    pending: document.getElementById('paymentResultIconPending')
}

const PAYMENT_RESULT_KINDS = {
    success: {
        titleKey: 'landing.checkout.paymentResultSuccessTitle',
        titleWithPackKey: 'landing.checkout.paymentResultSuccessTitleWithPack',
        messageKey: 'landing.checkout.paymentResultSuccessMessage',
        closeLabelKey: 'landing.checkout.paymentResultCloseLabel'
    },
    cancel: {
        titleKey: 'landing.checkout.paymentResultCancelTitle',
        messageKey: 'landing.checkout.paymentResultCancelMessage',
        closeLabelKey: 'landing.checkout.paymentResultCloseLabel'
    },
    pending: {
        titleKey: 'landing.checkout.paymentResultPendingTitle',
        messageKey: 'landing.checkout.paymentResultPendingMessage',
        closeLabelKey: 'landing.checkout.paymentResultPendingCloseLabel'
    }
}

// Maps the payment backend's itemId values to this shop's display-name lang
// keys (under [ejs.landing], hence queryEJS rather than queryJS here).
const PAYMENT_ITEM_NAME_KEYS = {
    commencement: 'landing.shopStarterName',
    intermediaire: 'landing.shopMidName',
    big: 'landing.shopBigName',
    prestige: 'landing.shopSupportName'
}

/**
 * Show the payment popup in one of three states:
 * - 'pending': shown immediately once the checkout page opens in the browser.
 * - 'success' / 'cancel': shown once the rolynk:// deep link callback fires,
 *   replacing whatever state (including 'pending') was showing before.
 *
 * @param {string} kind 'pending' | 'success' | 'cancel'
 * @param {{ itemId?: string }} [options] For 'success', the purchased
 * pack's itemId if known, so the title can name it explicitly.
 */
function showPaymentResult(kind, options){
    const config = PAYMENT_RESULT_KINDS[kind] || PAYMENT_RESULT_KINDS.success
    const itemId = options && options.itemId
    const packNameKey = itemId && PAYMENT_ITEM_NAME_KEYS[itemId]

    paymentResultPanel.parentElement.classList.remove('paymentResultCancel', 'paymentResultPending')
    if(kind === 'cancel' || kind === 'pending'){
        paymentResultPanel.parentElement.classList.add(kind === 'cancel' ? 'paymentResultCancel' : 'paymentResultPending')
    }
    Object.entries(paymentResultIcons).forEach(([iconKind, el]) => {
        el.style.display = iconKind === kind ? 'block' : 'none'
    })
    paymentResultTitle.textContent = (config.titleWithPackKey && packNameKey)
        ? Lang.queryJS(config.titleWithPackKey, { packName: Lang.queryEJS(packNameKey) })
        : Lang.queryJS(config.titleKey)
    paymentResultMessage.textContent = Lang.queryJS(config.messageKey)
    paymentResultClose.textContent = Lang.queryJS(config.closeLabelKey)
    paymentResultContainer.classList.add('paymentResultOpen')
}

function closePaymentResult(){
    paymentResultContainer.classList.remove('paymentResultOpen')
}

paymentResultClose.onclick = closePaymentResult
paymentResultContainer.onclick = (e) => {
    if(e.target === paymentResultContainer){
        closePaymentResult()
    }
}

ipcRenderer.on(PAYMENT_OPCODE.DEEP_LINK, (event, url) => {
    let kind = 'success'
    let itemId = null
    let sessionId = null
    try {
        const parsed = new URL(url)
        kind = parsed.hostname // rolynk://payment-success -> hostname === 'payment-success'
        // Expected to be sent by the payment provider's success page as
        // rolynk://payment-success?session_id=...&item=<itemId>.
        itemId = parsed.searchParams.get('item')
        sessionId = parsed.searchParams.get('session_id')
    } catch (err) {
        loggerLanding.error('Failed to parse payment deep link', url, err)
        return
    }

    if(kind.includes('cancel')){
        // A spoofed "cancelled" popup grants nothing and convinces nobody
        // of anything, so it doesn't need the same verification as success.
        localStorage.removeItem(PENDING_CHECKOUT_STORAGE_KEY)
        showPaymentResult('cancel')
        return
    }

    // Only show "payment confirmed" if this deep link's session_id matches
    // a checkout WE opened from this launcher. Otherwise any web page able
    // to trigger a rolynk:// link (via the OS "open app?" prompt) could
    // fake a success popup. This grants no crystals by itself — those only
    // come from the server-side Stripe webhook — but a fake confirmation is
    // still a believable social-engineering prop, so we stay silent unless
    // we can verify it.
    const verifiedItemId = consumeVerifiedPendingCheckout(sessionId)
    if(verifiedItemId === null){
        loggerLanding.warn('Ignoring unverified payment-success deep link (no matching pending checkout).')
        return
    }

    showPaymentResult('success', { itemId: verifiedItemId })
})
