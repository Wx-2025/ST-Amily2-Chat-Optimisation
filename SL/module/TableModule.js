import { Module, ModuleBuilder } from './Module.js';
import { bindTableEvents } from '../../ui/table-bindings.js';

const builder = new ModuleBuilder()
    .name('TableModule')
    .view('assets/amily-data-table/Memorisation-forms.html')
    .strict(true)
    .required(['mount']);

export default class TableModule extends Module {
    constructor() {
        super(builder);
    }

    async mount() {
        if (this.el) {
            this.el.id = 'amily2_memorisation_forms_panel';
            this.el.style.display = 'none';
        }
        bindTableEvents();
    }
}
