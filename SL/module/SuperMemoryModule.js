import { Module, ModuleBuilder } from './Module.js';
import { bindSuperMemoryEvents } from '../../core/super-memory/bindings.js';

const builder = new ModuleBuilder()
    .name('SuperMemory')
    .view('core/super-memory/index.html')
    .strict(true)
    .required(['mount']);

export default class SuperMemoryModule extends Module {
    constructor() {
        super(builder);
    }

    async mount() {
        if (this.el) {
            this.el.id = 'amily2_super_memory_panel';
            this.el.style.display = 'none';
        }
        bindSuperMemoryEvents();
    }
}
