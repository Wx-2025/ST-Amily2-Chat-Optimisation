import { Module, ModuleBuilder } from './Module.js';
import { bindHanlinyuanEvents } from '../../ui/hanlinyuan-bindings.js';

const builder = new ModuleBuilder()
    .name('Hanlinyuan')
    .view('assets/amily-hanlinyuan-system/hanlinyuan.html')
    .strict(true)
    .required(['mount']);

export default class HanlinyuanModule extends Module {
    constructor() {
        super(builder);
    }

    async mount() {
        if (this.el) {
            this.el.id = 'amily2_hanlinyuan_panel';
            this.el.style.display = 'none';
        }
        bindHanlinyuanEvents();
    }
}
