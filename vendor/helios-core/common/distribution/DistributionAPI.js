"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DistributionAPI = void 0;
const path_1 = require("path");
const got_1 = __importDefault(require("got"));
const LoggerUtil_1 = require("../../util/LoggerUtil");
const RestResponse_1 = require("../rest/RestResponse");
const fs_extra_1 = require("fs-extra");
const DistributionFactory_1 = require("./DistributionFactory");
// TODO Option to check endpoint for hash of distro for local compare
// Useful if distro is large (MBs)
const Security = require("../../rolynk-security");
class DistributionAPI {
    launcherDirectory;
    commonDir;
    instanceDir;
    remoteUrl;
    devMode;
    static log = LoggerUtil_1.LoggerUtil.getLogger('DistributionAPI');
    DISTRO_FILE = 'distribution.json';
    DISTRO_FILE_DEV = 'distribution_dev.json';
    distroPath;
    distroDevPath;
    distribution;
    rawDistribution;
    constructor(launcherDirectory, commonDir, instanceDir, remoteUrl, devMode) {
        this.launcherDirectory = launcherDirectory;
        this.commonDir = commonDir;
        this.instanceDir = instanceDir;
        this.remoteUrl = remoteUrl;
        this.devMode = devMode;
        this.distroPath = (0, path_1.resolve)(launcherDirectory, this.DISTRO_FILE);
        this.distroDevPath = (0, path_1.resolve)(launcherDirectory, this.DISTRO_FILE_DEV);
    }
    async getDistribution() {
        if (this.rawDistribution == null) {
            this.rawDistribution = await this.loadDistribution();
            this.distribution = new DistributionFactory_1.HeliosDistribution(this.rawDistribution, this.commonDir, this.instanceDir);
        }
        return this.distribution;
    }
    async getDistributionLocalLoadOnly() {
        if (this.rawDistribution == null) {
            const x = await this.pullLocal();
            if (x == null) {
                throw new Error('FATAL: Unable to load distribution from local disk.');
            }
            this.rawDistribution = x;
            this.distribution = new DistributionFactory_1.HeliosDistribution(this.rawDistribution, this.commonDir, this.instanceDir);
        }
        return this.distribution;
    }
    async refreshDistributionOrFallback() {
        const distro = await this._loadDistributionNullable();
        if (distro == null) {
            if (this.rawDistribution) Security.validateDistribution(this.rawDistribution);
            DistributionAPI.log.warn('Failed to refresh distribution, falling back to current load (if exists).');
            return this.distribution;
        }
        else {
            this.rawDistribution = distro;
            this.distribution = new DistributionFactory_1.HeliosDistribution(distro, this.commonDir, this.instanceDir);
            return this.distribution;
        }
    }
    toggleDevMode(dev) {
        this.devMode = dev;
    }
    isDevMode() {
        return this.devMode;
    }
    async loadDistribution() {
        const distro = await this._loadDistributionNullable();
        if (distro == null) {
            // TODO Bubble this up nicer
            throw new Error('FATAL: Unable to load distribution from remote server or local disk.');
        }
        return distro;
    }
    async _loadDistributionNullable() {
        let distro;
        if (!this.devMode) {
            distro = (await this.pullRemote()).data;
            if (distro == null) {
                distro = await this.pullLocal();
            }
            else {
                await this.writeDistributionToDisk(distro);
            }
        }
        else {
            distro = await this.pullLocal();
        }
        return distro;
    }
    async pullRemote() {
        try {
            const res = await got_1.default.get(this.remoteUrl, { responseType: 'json', timeout: { request: 10000 }, maxResponseSize: 2 * 1024 * 1024 });
            return {
                data: Security.validateDistribution(res.body),
                responseStatus: RestResponse_1.RestResponseStatus.SUCCESS
            };
        }
        catch (error) {
            return (0, RestResponse_1.handleGotError)('Pull Remote', error, DistributionAPI.log, () => null);
        }
    }
    async writeDistributionToDisk(distribution) {
        Security.validateDistribution(distribution);
        // Refuse rollback relative to the highest authenticated local release.
        const last = await this.pullLocal();
        if (last && last._security.sequence > distribution._security.sequence) throw new Error('Distribution rollback refused');
        await (0, fs_extra_1.writeJson)(this.distroPath, distribution);
    }
    async pullLocal() {
        return await this.readDistributionFromFile(!this.devMode ? this.distroPath : this.distroDevPath);
    }
    async readDistributionFromFile(path) {
        if (await (0, fs_extra_1.pathExists)(path)) {
            const raw = await (0, fs_extra_1.readFile)(path, 'utf-8');
            try {
                return Security.validateDistribution(JSON.parse(raw));
            }
            catch (error) {
                DistributionAPI.log.error(`Malformed distribution file at ${path}`);
                return null;
            }
        }
        else {
            DistributionAPI.log.error(`No distribution file found at ${path}!`);
            return null;
        }
    }
}
exports.DistributionAPI = DistributionAPI;
