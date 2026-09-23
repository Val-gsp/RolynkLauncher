"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FullRepairReceiver = void 0;
const DistributionAPI_1 = require("../../common/distribution/DistributionAPI");
const DistributionIndexProcessor_1 = require("../distribution/DistributionIndexProcessor");
const DownloadEngine_1 = require("../DownloadEngine");
const MojangIndexProcessor_1 = require("../mojang/MojangIndexProcessor");
const LoggerUtil_1 = require("../../util/LoggerUtil");
const FileUtils_1 = require("../../common/util/FileUtils");
const got_1 = require("got");
const fs = require("fs-extra");
const crypto = require("crypto");
const Security = require("../../rolynk-security");
const log = LoggerUtil_1.LoggerUtil.getLogger('FullRepairReceiver');
class FullRepairReceiver {
    processors = [];
    assets = [];
    async execute(message) {
        // Route to the correct function
        switch (message.action) {
            case 'validate':
                await this.validate(message);
                break;
            case 'download':
                await this.download(message);
                break;
        }
    }
    // Construct friendly error messages
    async parseError(error) {
        if (error instanceof got_1.RequestError) {
            if (error?.request?.requestUrl) {
                log.debug("Download request failed.");
            }
            if (error instanceof got_1.HTTPError) {
                log.debug('Response Details:');
                return `Error during request (HTTP Response ${error.response.statusCode})`;
            }
            else if (error.name === 'RequestError') {
                return `Request received no response (${error.code}).`;
            }
            else if (error instanceof got_1.TimeoutError) {
                return `Request timed out (${error.timings.phases.total}ms).`;
            }
            else if (error instanceof got_1.ParseError) {
                return 'Request received unexepected body (Parse Error).';
            }
            else if (error instanceof got_1.ReadError) {
                return `Read Error (${error.code}): ${error.message}.`;
            }
            else {
                // CacheError, MaxRedirectsError, UnsupportedProtocolError, CancelError
                return 'Error during request.';
            }
        }
        else {
            return undefined;
        }
    }
    async validate(message) {
        const api = new DistributionAPI_1.DistributionAPI(message.launcherDirectory, message.commonDirectory, message.instanceDirectory, null, // The main process must refresh, this is a local pull only.
        message.devMode);
        const distribution = await api.getDistributionLocalLoadOnly();
        const server = distribution.getServerById(message.serverId);
        const mojangIndexProcessor = new MojangIndexProcessor_1.MojangIndexProcessor(message.commonDirectory, server.rawServer.minecraftVersion);
        const distributionIndexProcessor = new DistributionIndexProcessor_1.DistributionIndexProcessor(message.commonDirectory, distribution, message.serverId);
        this.processors = [
            mojangIndexProcessor,
            distributionIndexProcessor
        ];
        // Init all
        let numStages = 0;
        for (const processor of this.processors) {
            await processor.init();
            numStages += processor.totalStages();
        }
        const assets = [];
        // Validate
        let completedStages = 0;
        for (const processor of this.processors) {
            Object.values(await processor.validate(async () => {
                completedStages++;
                process.send({ response: 'validateProgress', percent: Math.trunc((completedStages / numStages) * 100) });
            }))
                .flatMap(asset => asset)
                .forEach(asset => assets.push(asset));
        }
        const cached = new Map((message.verifiedVaultAssets || []).map(asset => [asset.id, asset.hash]));
        this.assets = assets.filter(asset => cached.get(asset.id) !== asset.hash);
        const authorization = message.downloadAuthorization;
        if (authorization) {
            if (!/^[a-zA-Z0-9_-]{20,128}$/.test(authorization.md5) || !Number.isSafeInteger(authorization.expires) || authorization.expires * 1000 <= Date.now()) throw new Error('Invalid download authorization');
            for (const asset of this.assets) {
                const url = new URL(asset.url);
                if (url.protocol === 'https:' && url.hostname === 'files.rolynk.fr' && url.pathname.startsWith('/rolynk/v1/mods/')) {
                    url.searchParams.set('md5', authorization.md5);
                    url.searchParams.set('expires', String(authorization.expires));
                    asset.url = url.href;
                }
            }
        }
        process.send({ response: 'validateComplete', invalidCount: this.assets.length });
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async download(_message) {
        const expectedTotalSize = (0, DownloadEngine_1.getExpectedDownloadSize)(this.assets);
        const downloads = this.assets.map(asset => ({ ...asset, path: asset.path + '.part-' + crypto.randomUUID() }));
        try {
            const received = await (0, DownloadEngine_1.downloadQueue)(downloads, bytes => {
                process.send({ response: 'downloadProgress', percent: Math.min(100, Math.trunc(bytes / Math.max(1, expectedTotalSize) * 100)) });
            });
            for (const asset of downloads) {
                if (received[asset.id] !== asset.size || !asset.hash ||
                    !await (0, FileUtils_1.validateLocalFile)(asset.path, asset.algo, asset.hash)) {
                    throw new Error('Downloaded content failed integrity validation.');
                }
            }
            for (let i = 0; i < downloads.length; i++) {
                Security.assertNoLinks(this.assets[i].path);
                await fs.move(downloads[i].path, this.assets[i].path, { overwrite: true });
            }
            for (const processor of this.processors) await processor.postDownload();
            process.send({ response: 'downloadComplete' });
        } finally {
            await Promise.all(downloads.map(asset => fs.remove(asset.path)));
        }
    }
}
exports.FullRepairReceiver = FullRepairReceiver;
