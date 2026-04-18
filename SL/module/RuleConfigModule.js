import { Module, ModuleBuilder } from './Module.js';
import { bindRuleConfigPanel } from '../../ui/rule-config-bindings.js';

const builder = new ModuleBuilder()
    .name('RuleConfig')
    .view('assets/rule-config-panel.html')
    .strict(true)
    .required(['mount']);

export default class RuleConfigModule extends Module {
    constructor() {
        super(builder);
    }

    async mount() {
        if (this.el) {
            this.el.id = 'amily2_rule_config_panel';
            this.el.style.display = 'none';
        }
        bindRuleConfigPanel($(this.el));
    }
}
