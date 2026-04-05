import { Module, ModuleBuilder } from './Module.js';

const builder = new ModuleBuilder()
    .name('AdditionalFeatures')
    .view('assets/amily-additional-features/Amily2-AdditionalFeatures.html');

export default class AdditionalFeaturesModule extends Module {
    constructor() {
        super(builder);
    }

    async mount() {
        if (this.el) {
            this.el.id = 'amily2_additional_features_panel';
            this.el.style.display = 'none';
        }
    }
}
