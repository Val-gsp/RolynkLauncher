"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HeliosModule = exports.HeliosServer = exports.HeliosDistribution = void 0;
const helios_distribution_types_1 = require("helios-distribution-types");
const MavenUtil_1 = require("../util/MavenUtil");
const path_1 = require("path");
const LoggerUtil_1 = require("../../util/LoggerUtil");
const MojangUtils_1 = require("../util/MojangUtils");
const Security = require("../../rolynk-security");
const logger = LoggerUtil_1.LoggerUtil.getLogger('DistributionFactory');
class HeliosDistribution {
    rawDistribution;
    mainServerIndex;
    servers;
    constructor(rawDistribution, commonDir, instanceDir) {
        Security.validateDistribution(rawDistribution);
        this.rawDistribution = structuredClone(rawDistribution);
        this.resolveMainServerIndex();
        this.servers = this.rawDistribution.servers.map(s => new HeliosServer(s, commonDir, instanceDir));
    }
    resolveMainServerIndex() {
        if (this.rawDistribution.servers.length > 0) {
            for (let i = 0; i < this.rawDistribution.servers.length; i++) {
                if (this.mainServerIndex == null) {
                    if (this.rawDistribution.servers[i].mainServer) {
                        this.mainServerIndex = i;
                    }
                }
                else {
                    this.rawDistribution.servers[i].mainServer = false;
                }
            }
            if (this.mainServerIndex == null) {
                this.mainServerIndex = 0;
                this.rawDistribution.servers[this.mainServerIndex].mainServer = true;
            }
        }
        else {
            logger.warn('Distribution has 0 configured servers. This doesnt seem right..');
            this.mainServerIndex = 0;
        }
    }
    getMainServer() {
        return this.mainServerIndex < this.servers.length ? this.servers[this.mainServerIndex] : null;
    }
    getServerById(id) {
        return this.servers.find(s => s.rawServer.id === id) || null;
    }
}
exports.HeliosDistribution = HeliosDistribution;
class HeliosServer {
    rawServer;
    modules;
    hostname;
    port;
    effectiveJavaOptions;
    constructor(rawServer, commonDir, instanceDir) {
        this.rawServer = rawServer;
        const { hostname, port } = this.parseAddress();
        this.hostname = hostname;
        this.port = port;
        this.effectiveJavaOptions = this.parseEffectiveJavaOptions();
        this.modules = rawServer.modules.map(m => new HeliosModule(m, rawServer.id, commonDir, instanceDir));
    }
    parseAddress() {
        // Srv record lookup here if needed.
        if (this.rawServer.address.includes(':')) {
            const pieces = this.rawServer.address.split(':');
            const port = Number(pieces[1]);
            if (!Number.isInteger(port)) {
                throw new Error(`Malformed server address for ${this.rawServer.id}. Port must be an integer!`);
            }
            return { hostname: pieces[0], port };
        }
        else {
            return { hostname: this.rawServer.address, port: 25565 };
        }
    }
    parseEffectiveJavaOptions() {
        const options = this.rawServer.javaOptions?.platformOptions ?? [];
        const mergeableProps = [];
        for (const option of options) {
            if (option.platform === process.platform) {
                if (option.architecture === process.arch) {
                    mergeableProps[0] = option;
                }
                else {
                    mergeableProps[1] = option;
                }
            }
        }
        mergeableProps[3] = {
            distribution: this.rawServer.javaOptions?.distribution,
            supported: this.rawServer.javaOptions?.supported,
            suggestedMajor: this.rawServer.javaOptions?.suggestedMajor
        };
        const merged = {};
        for (let i = mergeableProps.length - 1; i >= 0; i--) {
            if (mergeableProps[i] != null) {
                merged.distribution = mergeableProps[i].distribution;
                merged.supported = mergeableProps[i].supported;
                merged.suggestedMajor = mergeableProps[i].suggestedMajor;
            }
        }
        return this.defaultUndefinedJavaOptions(merged);
    }
    defaultUndefinedJavaOptions(props) {
        const [defaultRange, defaultSuggestion] = this.defaultJavaVersion();
        return {
            supported: props.supported ?? defaultRange,
            distribution: props.distribution ?? this.defaultJavaPlatform(),
            suggestedMajor: props.suggestedMajor ?? defaultSuggestion,
        };
    }
    defaultJavaVersion() {
        if ((0, MojangUtils_1.mcVersionAtLeast)('1.20.5', this.rawServer.minecraftVersion)) {
            return ['>=21.x', 21];
        }
        else if ((0, MojangUtils_1.mcVersionAtLeast)('1.17', this.rawServer.minecraftVersion)) {
            return ['>=17.x', 17];
        }
        else {
            return ['8.x', 8];
        }
    }
    defaultJavaPlatform() {
        return process.platform === helios_distribution_types_1.Platform.DARWIN ? helios_distribution_types_1.JdkDistribution.CORRETTO : helios_distribution_types_1.JdkDistribution.TEMURIN;
    }
}
exports.HeliosServer = HeliosServer;
class HeliosModule {
    rawModule;
    serverId;
    subModules;
    mavenComponents;
    required;
    localPath;
    constructor(rawModule, serverId, commonDir, instanceDir) {
        this.rawModule = rawModule;
        this.serverId = serverId;
        this.mavenComponents = this.resolveMavenComponents();
        this.required = this.resolveRequired();
        this.localPath = this.resolveLocalPath(commonDir, instanceDir);
        if (this.rawModule.subModules != null) {
            this.subModules = this.rawModule.subModules.map(m => new HeliosModule(m, serverId, commonDir, instanceDir));
        }
        else {
            this.subModules = [];
        }
    }
    resolveMavenComponents() {
        // Files need not have a maven identifier if they provide a path.
        if (this.rawModule.type === helios_distribution_types_1.Type.File && this.rawModule.artifact.path != null) {
            return null;
        }
        // Version Manifests never provide a maven identifier.
        if (this.rawModule.type === helios_distribution_types_1.Type.VersionManifest) {
            return null;
        }
        const isMavenId = MavenUtil_1.MavenUtil.isMavenIdentifier(this.rawModule.id);
        if (!isMavenId) {
            if (this.rawModule.type !== helios_distribution_types_1.Type.File) {
                throw new Error(`Module ${this.rawModule.name} (${this.rawModule.id}) of type ${this.rawModule.type} must have a valid maven identifier!`);
            }
            else {
                throw new Error(`Module ${this.rawModule.name} (${this.rawModule.id}) of type ${this.rawModule.type} must either declare an artifact path or have a valid maven identifier!`);
            }
        }
        try {
            return MavenUtil_1.MavenUtil.getMavenComponents(this.rawModule.id);
        }
        catch (err) {
            throw new Error(`Failed to resolve maven components for module ${this.rawModule.name} (${this.rawModule.id}) of type ${this.rawModule.type}. Reason: ${err.message}`);
        }
    }
    resolveRequired() {
        if (this.rawModule.required == null) {
            return {
                value: true,
                def: true
            };
        }
        else {
            return {
                value: this.rawModule.required.value ?? true,
                def: this.rawModule.required.def ?? true
            };
        }
    }
    resolveLocalPath(commonDir, instanceDir) {
        if (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,120}$/.test(this.serverId)) throw new Error('Invalid server ID');
        // Version Manifests have a pre-determined path.
        if (this.rawModule.type === helios_distribution_types_1.Type.VersionManifest) {
            return Security.safePath(commonDir, 'versions', this.rawModule.id, `${this.rawModule.id}.json`);
        }
        const relativePath = this.rawModule.artifact.path ?? MavenUtil_1.MavenUtil.mavenComponentsAsNormalizedPath(this.mavenComponents.group, this.mavenComponents.artifact, this.mavenComponents.version, this.mavenComponents.classifier, this.mavenComponents.extension);
        switch (this.rawModule.type) {
            case helios_distribution_types_1.Type.Library:
            case helios_distribution_types_1.Type.Forge:
            case helios_distribution_types_1.Type.ForgeHosted:
            case helios_distribution_types_1.Type.Fabric:
            case helios_distribution_types_1.Type.LiteLoader:
                return Security.safePath(commonDir, 'libraries', relativePath);
            case helios_distribution_types_1.Type.ForgeMod:
            case helios_distribution_types_1.Type.LiteMod:
                // TODO Move to /mods/forge eventually..
                return Security.safePath(commonDir, 'modstore', relativePath);
            case helios_distribution_types_1.Type.FabricMod:
                return Security.safePath(commonDir, 'mods', 'fabric', relativePath);
            case helios_distribution_types_1.Type.File:
            default:
                return Security.safePath(instanceDir, this.serverId, relativePath);
        }
    }
    hasMavenComponents() {
        return this.mavenComponents != null;
    }
    getMavenComponents() {
        return this.mavenComponents;
    }
    getRequired() {
        return this.required;
    }
    getPath() {
        return this.localPath;
    }
    getMavenIdentifier() {
        return MavenUtil_1.MavenUtil.mavenComponentsToIdentifier(this.mavenComponents.group, this.mavenComponents.artifact, this.mavenComponents.version, this.mavenComponents.classifier, this.mavenComponents.extension);
    }
    getExtensionlessMavenIdentifier() {
        return MavenUtil_1.MavenUtil.mavenComponentsToExtensionlessIdentifier(this.mavenComponents.group, this.mavenComponents.artifact, this.mavenComponents.version, this.mavenComponents.classifier);
    }
    getVersionlessMavenIdentifier() {
        return MavenUtil_1.MavenUtil.mavenComponentsToVersionlessIdentifier(this.mavenComponents.group, this.mavenComponents.artifact, this.mavenComponents.classifier);
    }
    hasSubModules() {
        return this.subModules.length > 0;
    }
}
exports.HeliosModule = HeliosModule;
