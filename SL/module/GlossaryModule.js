import { Module, ModuleBuilder } from './Module.js';

const builder = new ModuleBuilder()
    .name('Glossary')
    .view('assets/amily-glossary-system/amily2-glossary.html')
    .strict(true)
    .required(['mount']);

export default class GlossaryModule extends Module {
    constructor() {
        super(builder);
    }

    async mount() {
        if (this.el) {
            this.el.id = 'amily2_glossary_panel';
            this.el.style.display = 'none';
        }
        // bindGlossaryEvents 由 index.js 中 waitForGlossaryPanelAndBindEvents 轮询调用
        // 模块化后面板已就绪，可直接绑定
        const { bindGlossaryEvents } = await import('../../glossary/GT_bindings.js');
        bindGlossaryEvents();
    }
}
