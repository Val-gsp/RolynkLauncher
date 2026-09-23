"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FullRepair = void 0;
const child_process_1 = require("child_process");
const path_1 = require("path");
const LoggerUtil_1 = require("../util/LoggerUtil");
const log = LoggerUtil_1.LoggerUtil.getLogger('Transmitter');
class BaseTransmitter {
    receiver;
    spawnReceiver(additionalEnvVars) {
        if (this.receiver != null) {
            throw new Error('Receiver already spawned!');
        }
        const forkOptions = {
            stdio: 'pipe'
        };
        if (additionalEnvVars) {
            // Copy and enrich current env
            const forkEnv = {
                ...JSON.parse(JSON.stringify(process.env)),
                ...additionalEnvVars
            };
            forkOptions.env = forkEnv;
        }
        this.receiver = (0, child_process_1.fork)((0, path_1.join)(__dirname, 'receivers', 'ReceiverExecutor.js'), [this.receiverName()], forkOptions);
        // Stdout
        this.receiver.stdio[1].setEncoding('utf8');
        this.receiver.stdio[1].on('data', (data) => {
            `${data}`.trim().split('\n')
                .forEach(line => console.log(`\x1b[32m[_]\x1b[0m ${line}`));
        });
        // Stderr
        this.receiver.stdio[2].setEncoding('utf8');
        this.receiver.stdio[2].on('data', (data) => {
            `${data}`.trim().split('\n')
                .forEach(line => console.log(`\x1b[31m[_]\x1b[0m ${line}`));
        });
    }
    destroyReceiver() {
        this.receiver.disconnect();
        this.receiver = null;
    }
    get childProcess() {
        return this.receiver;
    }
}
class FullRepair extends BaseTransmitter {
    commonDirectory;
    instanceDirectory;
    launcherDirectory;
    serverId;
    devMode;
    constructor(commonDirectory, instanceDirectory, launcherDirectory, serverId, devMode) {
        super();
        this.commonDirectory = commonDirectory;
        this.instanceDirectory = instanceDirectory;
        this.launcherDirectory = launcherDirectory;
        this.serverId = serverId;
        this.devMode = devMode;
    }
    receiverName() {
        return 'FullRepairReceiver';
    }
    verifyFiles(onProgress, securityContext = {}) {
        return new Promise((resolve, reject) => {
            const onMessageHandle = (message) => {
                switch (message.response) {
                    case 'validateProgress':
                        log.debug('Received validate progress ' + message.percent);
                        onProgress(message.percent);
                        break;
                    case 'validateComplete':
                        log.info('Received validation complete.');
                        this.receiver.removeListener('message', onMessageHandle);
                        resolve(message.invalidCount);
                        break;
                    case 'error':
                        log.error('Received error.');
                        this.receiver.disconnect();
                        reject(message);
                        break;
                }
            };
            this.receiver.on('message', onMessageHandle);
            this.receiver.send({
                action: 'validate',
                verifiedVaultAssets: securityContext.verifiedVaultAssets,
                downloadAuthorization: securityContext.downloadAuthorization,
                commonDirectory: this.commonDirectory,
                instanceDirectory: this.instanceDirectory,
                launcherDirectory: this.launcherDirectory,
                serverId: this.serverId,
                devMode: this.devMode
            });
        });
    }
    download(onProgress) {
        return new Promise((resolve, reject) => {
            const onMessageHandle = (message) => {
                switch (message.response) {
                    case 'downloadProgress':
                        log.debug('Received download progress ' + message.percent);
                        onProgress(message.percent);
                        break;
                    case 'downloadComplete':
                        log.info('Received download complete.');
                        this.receiver.removeListener('message', onMessageHandle);
                        resolve();
                        break;
                    case 'error':
                        log.error('Received error.');
                        this.receiver.disconnect();
                        reject(message);
                        break;
                }
            };
            this.receiver.on('message', onMessageHandle);
            this.receiver.send({
                action: 'download'
            });
        });
    }
}
exports.FullRepair = FullRepair;
