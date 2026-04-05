import { Module, ModuleBuilder } from './Module.js';
import { bindApiConfigPanel } from '../../ui/api-config-bindings.js';
import { syncAllSlots } from '../../ui/profile-sync.js';

const builder = new ModuleBuilder()
    .name('ApiConfig')
    .view('assets/api-config-panel.html')
    .strict(true)
    .required(['mount']);

export default class ApiConfigModule extends Module {
    constructor() {
        super(builder);
    }

    async mount() {
        if (this.el) {
            this.el.id = 'amily2_api_config_panel';
            this.el.style.display = 'none';
        }
        bindApiConfigPanel($(this.el));
        syncAllSlots();
    }

    expose() {
        return { syncAllSlots };
    }
}
