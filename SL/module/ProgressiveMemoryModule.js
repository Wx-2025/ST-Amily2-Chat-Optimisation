import { Module, ModuleBuilder } from './Module.js';
import { bindProgressiveMemoryEvents } from '../../core/progressive-memory/bindings.js';

const builder = new ModuleBuilder()
    .name('ProgressiveMemory')
    .view('core/progressive-memory/index.html')
    .strict(true)
    .required(['mount']);

export default class ProgressiveMemoryModule extends Module {
    constructor() {
        super(builder);
    }

    async mount() {
        if (this.el) {
            this.el.id = 'amily2_progressive_memory_panel';
            this.el.style.display = 'none';
        }
        bindProgressiveMemoryEvents();
    }
}
