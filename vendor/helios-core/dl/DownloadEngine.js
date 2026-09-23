"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getExpectedDownloadSize = getExpectedDownloadSize;
exports.downloadQueue = downloadQueue;
exports.downloadFile = downloadFile;
const fs_1 = require("fs");
const got_1 = __importStar(require("got"));
const promises_1 = require("stream/promises");
const fastq = __importStar(require("fastq"));
const fs_extra_1 = require("fs-extra");
const path_1 = require("path");
const LoggerUtil_1 = require("../util/LoggerUtil");
const NodeUtil_1 = require("../util/NodeUtil");
const Security = require("../rolynk-security");
const log = LoggerUtil_1.LoggerUtil.getLogger('DownloadEngine');
function getExpectedDownloadSize(assets) {
    return assets.map(({ size }) => size).reduce((acc, v) => acc + v, 0);
}
async function downloadQueue(assets, onProgress) {
    const receivedTotals = assets.map(({ id }) => id).reduce((acc, id) => ({ ...acc, [id]: 0 }), ({}));
    let received = 0;
    const onEachProgress = (asset) => {
        return ({ transferred }) => {
            received += (transferred - receivedTotals[asset.id]);
            receivedTotals[asset.id] = transferred;
            onProgress(received);
        };
    };
    const wrap = (asset) => downloadFile(asset.url, asset.path, onEachProgress(asset));
    const q = fastq.promise(wrap, 15);
    const promises = assets.map(asset => q.push(asset)).reduce((acc, p) => ([...acc, p]), []);
    const settled = await Promise.allSettled(promises);
    const failed = settled.find(result => result.status === "rejected");
    if (failed) throw failed.reason;
    return receivedTotals;
}
async function downloadFile(url, path, onProgress) {
    Security.assertNoLinks(path);
    await (0, fs_extra_1.ensureDir)((0, path_1.dirname)(path));
    const MAX_RETRIES = 10;
    let fileWriterStream = null; // The write stream.
    let retryCount = 0; // The number of retries attempted.
    let error = null; // The caught error.
    let retry = false; // Should we retry.
    let rethrow = false; // Should we throw an error.
    // Got's streaming retry API is nonexistant and their "example" is egregious.
    // To use their "api" you need to commit yourself to recursive callback hell.
    // No thank you, I prefer this simpler, non error-prone logic.
    do {
        retry = false;
        rethrow = false;
        if (retryCount > 0) {
            log.debug(`Retry attempt #${retryCount} for [private URL].`);
        }
        try {
            const downloadStream = got_1.default.stream(url, {
                timeout: { request: 30000 },
                followRedirect: new URL(url).hostname !== 'files.rolynk.fr',
                hooks: { beforeRedirect: [options => { if (options.url.protocol !== 'https:') throw new Error('Insecure download redirect'); }] }
            });
            fileWriterStream = (0, fs_1.createWriteStream)(path, { flags: fs_1.constants.O_WRONLY | fs_1.constants.O_CREAT | fs_1.constants.O_TRUNC | (fs_1.constants.O_NOFOLLOW || 0), mode: 0o600 });
            if (onProgress) {
                downloadStream.on('downloadProgress', (progress) => onProgress(progress));
            }
            await (0, promises_1.pipeline)(downloadStream, fileWriterStream);
        }
        catch (err) {
            error = err;
            retryCount++;
            rethrow = true;
            // For now, only retry timeouts.
            retry = retryCount <= MAX_RETRIES && retryableError(error);
            if (fileWriterStream) {
                fileWriterStream.destroy();
            }
            if (onProgress && retry) {
                // Reset progress on this asset. since we're going to retry.
                onProgress({ transferred: 0, percent: 0, total: 0 });
            }
            if (retry) {
                // Wait one second before retrying.
                // This can become an exponential backoff, but I see no need for that right now.
                await (0, NodeUtil_1.sleep)(1000);
            }
        }
    } while (retry);
    if (rethrow && error) {
        if (retryCount > MAX_RETRIES) {
            log.error(`Maximum retries attempted for [private URL]. Rethrowing exception.`);
        }
        else {
            log.error(`Unknown or unretryable exception thrown during request to [private URL]. Rethrowing exception.`);
        }
        throw error;
    }
}
function retryableError(error) {
    if (error instanceof got_1.RequestError) {
        // error.name === 'RequestError' means server did not respond.
        return error.name === 'RequestError' || error instanceof got_1.ReadError && error.code === 'ECONNRESET';
    }
    else {
        return false;
    }
}
