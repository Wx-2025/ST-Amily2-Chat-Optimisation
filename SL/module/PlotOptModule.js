import { Module, ModuleBuilder } from './Module.js';
import { initializePlotOptimizationBindings } from '../../ui/plot-opt-bindings.js';

const builder = new ModuleBuilder()
    .name('PlotOptimization')
    .view('assets/Amily2-optimization.html')
    .strict(true)
    .required(['mount']);

export default class PlotOptModule extends Module {
    constructor() {
        super(builder);
    }

    async mount() {
        if (this.el) {
            this.el.id = 'amily2_plot_optimization_panel';
            this.el.style.display = 'none';
        }
        initializePlotOptimizationBindings();
    }
}
