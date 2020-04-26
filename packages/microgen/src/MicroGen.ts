import IPackage from './IPackage';
import IGenerator from './IGenerator';
import FilesPlugin from './plugins/files';
import IPlugin, {PluginConfig} from './IPlugin';
import {render, renderFile, jsStringify, copy, writeFile} from './utils';

const fs = require('fs');

export type GeneratorConfig = {
    rootDir: string,
    vars?: any,
    plugins?: (PluginConfig|string)[],
    packages?: {[key: string]: any},
};

export type MicroGenConfig = GeneratorConfig & {}

export class MicroGen implements IGenerator {
    public readonly plugins: IPlugin[] = [];
    public readonly packagers: {[key: string]: (config: any) => IPackage} = {};
    public readonly packages: {[key: string]: any} = {};
    public readonly vars: {[key: string]: any} = {};
    public readonly defaultPackagerName: string = 'js_lambda';
    public readonly rootDir: string
    protected readonly packageEventHooks = {};
    constructor({rootDir, plugins = [], packages = {}, vars = {}}: MicroGenConfig) {
        this.rootDir = rootDir;
        this.vars = {
            generator: 'microgen',
            license: 'MIT',
            date: new Date().toISOString(),
            rootDir: this.rootDir,
            defaultPackageType: 'files',
            ...vars,
            verbose: vars.verbose || process.env.MICROGEN_VERBOSE || 0,
        };
        this.packages = packages;
        const localPlugin = `${rootDir}/.microgen`;
        try {
            const localPluginPath = fs.realpathSync(localPlugin);
            if (localPluginPath) plugins.push('./.microgen');
        } catch (e) {
            // nothing to do, local plugin does not exist.
        }
        this.loadPlugins(plugins);
        this.registerPlugin(new FilesPlugin());
    }
    protected loadPlugins(plugins: any[]): void {
        plugins.forEach(p => {
            if ('string' === typeof p) p = {name: p};
            if ((p.name.slice(0, 1) === '@') &&  (-1 === p.name.indexOf('/')))
                p.name = `@ohoareau/microgen-plugin-${p.name.slice(1)}`;
            this.registerPluginFromConfig(p)
        });
    }
    getRootDir(): string {
        return this.rootDir;
    }
    getVars(): {[key: string]: any} {
        return this.vars;
    }
    setVar(key: string, value: any) {
        this.vars[key] = value;
    }
    registerPackager(type: string|string[], packager: (config: any) => IPackage) {
        (Array.isArray(type) ? type : [type]).forEach(t => {
            const tt = t.replace(/-/g, '_');
            this.packagers[t] = packager;
            if (tt !== t) {
                this.packagers[tt] = packager;
            }
        });
    }
    registerPackageEventHook(packageType: string, eventType: string, hook: Function): void {
        if (!this.packageEventHooks[packageType]) this.packageEventHooks[packageType] = {};
        if (!this.packageEventHooks[packageType][eventType]) this.packageEventHooks[packageType][eventType] = [];
        this.packageEventHooks[packageType][eventType].push(hook);
    }
    async describePackages(): Promise<any[]> {
        return (await this.prepare()).map((p: any) => {
            return {
                name: p.getName ? p.getName() : p.name,
                type: p.getPackageType ? p.getPackageType() : p.packageType,
            };
        });
    }
    protected applyPackageEventHooks(p: IPackage, eventType: string, data: any = {}): void {
        let hooks = <Function[]>[];
        const packageType = p.getName ? p.getName() : (p['name'] ? p['name'] : undefined);
        if (!packageType) return;
        if (this.packageEventHooks[packageType]) {
            if (this.packageEventHooks[packageType][eventType])
                hooks = hooks.concat(this.packageEventHooks[packageType][eventType]);
            if (this.packageEventHooks[packageType]['*'])
                hooks = hooks.concat(this.packageEventHooks[packageType]['*']);
        }
        if (this.packageEventHooks['*']) {
            if (this.packageEventHooks['*'][eventType])
                hooks = hooks.concat(this.packageEventHooks['*'][eventType]);
            if (this.packageEventHooks['*']['*'])
                hooks = hooks.concat(this.packageEventHooks['*'][eventType]);
        }
        const ctx = {data};
        hooks.forEach(h => h(p, eventType, ctx));
    }
    registerPlugin(plugin: IPlugin) {
        plugin.register(this);
        this.plugins.push(plugin);
    }
    registerPluginFromConfig(plugin: string|PluginConfig) {
        this.registerPlugin(this.createPluginFromConfig('string' === typeof plugin ? {name: plugin} : plugin));
    }
    createPluginFromConfig(plugin: PluginConfig): IPlugin {
        let path = plugin.path || plugin.name;
        if ('.' === path.slice(0, 1)) {
            path = fs.realpathSync(`${this.rootDir}/${path}`);
        }
        const r = require(path);
        const pluginClass = r.default || r;

        return new pluginClass({...(plugin.config || {}), loadedFrom: path});
    }
    private async prepare(): Promise<IPackage[]> {
        return Object.entries(this.packages).map(
            ([name, {type, ...c}]: [string, any]) => {
                if (!type) {
                    if (!this.vars.defaultPackageType) throw new Error(`No type specified for package '${name}'`);
                    type = this.vars.defaultPackageType;
                }
                if (!this.packagers[type]) throw new Error(`Unsupported package type '${type}'`);
                const p = this.packagers[type]({...c, packageType: type, name, vars: {...this.vars, ...(c.vars || {})}});
                this.applyPackageEventHooks(p, 'created');
                return p;
            }
        );
    }
    async generate(vars: any = {}): Promise<{[key: string]: Function}> {
        const packages = await this.prepare();
        vars.verbose = vars.verbose || process.env.MICROGEN_VERBOSE || 0;
        const {write = false, targetDir} = vars;
        const result = (await Promise.all(packages.map(async p => {
            const n = (<any>p).getName ? (<any>p).getName() : p['name'];
            this.applyPackageEventHooks(p, 'before_generate');
            const generateResult = await p.generate(vars);
            this.applyPackageEventHooks(p, 'after_generate', generateResult);
            return [n, generateResult];
        })))
            .reduce(
                (acc, [p, f]) =>
                    Object.entries(f).reduce((acc2, [k, v]) => {
                        acc2[`${p}/${k}`] = [p, v];
                        return acc2;
                    }, acc)
                ,
                {}
            )
        ;
        const entries = Object.entries(result);
        entries.sort(([k1], [k2]) => k1 < k2 ? -1 : (k1 === k2 ? 0 : 1));
        entries.forEach(([k, x]) => {
            const [p, v] = <any>x;
            const filePath = `${targetDir}/${k}`;
            if (!this.vars || !this.vars.locked || !this.vars.locked[k]) {
                if (vars.verbose >= 1) console.log(k);
                result[k] = (<any>v)(this.createPackageHelpers(p, vars));
                if (write && (true !== result[k])) writeFile(filePath, result[k]);
            }
        });
        return result;
    }
    init(): void {
        writeFile(
            `${this.rootDir}/microgen.js`,
            renderFile({templatePath: `${__dirname}/../templates`})('microgen.js.ejs', {config: jsStringify({
                plugins: [],
                vars: {},
                packages: {},
            })})
        );
    }
    createPackageHelpers(name, vars) {
        return {
            render,
            renderFile,
            jsStringify,
            copy: (source, target) => copy(source, `${vars.targetDir}/${name}/${target}`),
        };
    }
}

export default MicroGen