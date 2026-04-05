import { Module, ModuleBuilder } from './Module.js';
import { initializeRendererBindings } from '../../core/tavern-helper/renderer-bindings.js';

const builder = new ModuleBuilder()
    .name('Renderer')
    .view('core/tavern-helper/renderer.html')
    .strict(true)
    .required(['mount']);

export default class RendererModule extends Module {
    constructor() {
        super(builder);
    }

    async mount() {
        if (this.el) {
            this.el.id = 'amily2_renderer_panel';
            this.el.style.display = 'none';
        }
        initializeRendererBindings();
    }
}
