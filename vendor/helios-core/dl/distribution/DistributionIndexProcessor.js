"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DistributionIndexProcessor = void 0;
const LoggerUtil_1 = require("../../util/LoggerUtil");
const IndexProcessor_1 = require("../IndexProcessor");
const AssetGuardError_1 = require("../AssetGuardError");
const FileUtils_1 = require("../../common/util/FileUtils");
const Asset_1 = require("../Asset");
const helios_distribution_types_1 = require("helios-distribution-types");
const MojangUtils_1 = require("../../common/util/MojangUtils");
const fs_extra_1 = require("fs-extra");
const node_stream_zip_1 = __importDefault(require("node-stream-zip"));
const path_1 = require("path");
class DistributionIndexProcessor extends IndexProcessor_1.IndexProcessor {
    distribution;
    serverId;
    static logger = LoggerUtil_1.LoggerUtil.getLogger('DistributionIndexProcessor');
    constructor(commonDir, distribution, serverId) {
        super(commonDir);
        this.distribution = distribution;
        this.serverId = serverId;
    }
    async init() {
        // no-op
    }
    totalStages() {
        return 1;
    }
    async validate(onStageComplete) {
        const server = this.distribution.getServerById(this.serverId);
        if (server == null) {
            throw new AssetGuardError_1.AssetGuardError(`Invalid server id ${this.serverId}`);
        }
        const notValid = [];
        await this.validateModules(server.modules, notValid);
        await onStageComplete();
        return {
            distribution: notValid
        };
    }
    async postDownload() {
        await this.loadModLoaderVersionJson();
    }
    async validateModules(modules, accumulator) {
        for (const module of modules) {
            const hash = module.rawModule.artifact.SHA256;
            if (!await (0, FileUtils_1.validateLocalFile)(module.getPath(), Asset_1.HashAlgo.SHA256, hash)) {
                accumulator.push({
                    id: module.rawModule.id,
                    hash: hash,
                    algo: Asset_1.HashAlgo.SHA256,
                    size: module.rawModule.artifact.size,
                    url: module.rawModule.artifact.url,
                    path: module.getPath()
                });
            }
            if (module.hasSubModules()) {
                await this.validateModules(module.subModules, accumulator);
            }
        }
    }
    async loadModLoaderVersionJson() {
        const server = this.distribution.getServerById(this.serverId);
        if (server == null) {
            throw new AssetGuardError_1.AssetGuardError(`Invalid server id ${this.serverId}`);
        }
        const modLoaderModule = server.modules.find(({ rawModule: { type } }) => type === helios_distribution_types_1.Type.ForgeHosted || type === helios_distribution_types_1.Type.Forge || type === helios_distribution_types_1.Type.Fabric);
        if (modLoaderModule == null) {
            throw new AssetGuardError_1.AssetGuardError('No mod loader found!');
        }
        if (modLoaderModule.rawModule.type === helios_distribution_types_1.Type.Fabric
            || DistributionIndexProcessor.isForgeGradle3(server.rawServer.minecraftVersion, modLoaderModule.getMavenComponents().version)) {
            return await this.loadVersionManifest(modLoaderModule);
        }
        else {
            const zip = new node_stream_zip_1.default.async({ file: modLoaderModule.getPath() });
            try {
                const data = JSON.parse((await zip.entryData('version.json')).toString('utf8'));
                const writePath = (0, FileUtils_1.getVersionJsonPath)(this.commonDir, data.id);
                await (0, fs_extra_1.ensureDir)((0, path_1.dirname)(writePath));
                await (0, fs_extra_1.writeJson)(writePath, data);
                return data;
            }
            finally {
                await zip.close();
            }
        }
    }
    async loadVersionManifest(modLoaderModule) {
        const versionManifstModule = modLoaderModule.subModules.find(({ rawModule: { type } }) => type === helios_distribution_types_1.Type.VersionManifest);
        if (versionManifstModule == null) {
            throw new AssetGuardError_1.AssetGuardError('No mod loader version manifest module found!');
        }
        return await (0, fs_extra_1.readJson)(versionManifstModule.getPath(), 'utf-8');
    }
    // TODO Move this to a util maybe
    static isForgeGradle3(mcVersion, forgeVersion) {
        if ((0, MojangUtils_1.mcVersionAtLeast)('1.13', mcVersion)) {
            return true;
        }
        try {
            const forgeVer = forgeVersion.split('-')[1];
            const maxFG2 = [14, 23, 5, 2847];
            const verSplit = forgeVer.split('.').map(v => Number(v));
            for (let i = 0; i < maxFG2.length; i++) {
                if (verSplit[i] > maxFG2[i]) {
                    return true;
                }
                else if (verSplit[i] < maxFG2[i]) {
                    return false;
                }
            }
            return false;
        }
        catch (err) {
            throw new Error('Forge version is complex (changed).. launcher requires a patch.');
        }
    }
}
exports.DistributionIndexProcessor = DistributionIndexProcessor;
