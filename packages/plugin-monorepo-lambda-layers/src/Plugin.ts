import Package from './Package';
import {IGenerator, IPlugin} from '@ohoareau/microgen';

export default class Plugin implements IPlugin {
    register(generator: IGenerator): void {
        generator.registerPackager('monorepo-lambda-layers', cfg => new Package(cfg));
    }
}
