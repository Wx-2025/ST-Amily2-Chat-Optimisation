import { Module, ModuleBuilder } from './Module.js';
import { extensionName } from '../../utils/settings.js';

const builder = new ModuleBuilder()
    .name('WorldEditor')
    .view('WorldEditor.html');

export default class WorldEditorModule extends Module {
    constructor() {
        super(builder);
    }

    async mount() {
        if (this.el) {
            this.el.id = 'amily2_world_editor_panel';
            this.el.style.display = 'none';
        }
        // WorldEditor.js 必须作为 <script type="module"> 加载
        const scriptId = 'world-editor-script';
        if (!document.getElementById(scriptId)) {
            const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
            const script = document.createElement('script');
            script.id = scriptId;
            script.type = 'module';
            script.src = `${extensionFolderPath}/WorldEditor/WorldEditor.js?v=${Date.now()}`;
            document.head.appendChild(script);
        }
    }
}
