import { Module, ModuleBuilder } from './Module.js';
import { bindHistoriographyEvents } from '../../ui/historiography-bindings.js';

const builder = new ModuleBuilder()
    .name('Historiography')
    .view('assets/Amily2-TextOptimization.html')
    .strict(true)
    .required(['mount']);

export default class HistoriographyModule extends Module {
    constructor() {
        super(builder);
    }

    async mount() {
        if (this.el) {
            this.el.id = 'amily2_text_optimization_panel';
            this.el.style.display = 'none';
        }
        bindHistoriographyEvents();
    }
}
