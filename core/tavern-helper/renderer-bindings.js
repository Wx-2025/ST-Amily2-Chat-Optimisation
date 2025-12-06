import { renderAllIframes, clearAllIframes, initializeRenderer } from './renderer.js';
import { extension_settings } from "/scripts/extensions.js";
import { extensionName } from "../../utils/settings.js";
import { saveSettingsDebounced } from "/script.js";

let isRendererInitialized = false;

export function initializeRendererBindings() {
    const container = $("#amily2_drawer_content").length
        ? $("#amily2_drawer_content")
        : $("#amily2_chat_optimiser");

    if (!container.length) {
        console.warn("[Amily2-Renderer] Could not find the settings container.");
        return;
    }
    container.on('change', '#amily-render-enable-toggle', function () {
        const isChecked = this.checked;

        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {};
        }
        extension_settings[extensionName].amily_render_enabled = isChecked;
        saveSettingsDebounced();

        if (isChecked && !isRendererInitialized) {
            initializeRenderer();
            isRendererInitialized = true;
            console.log("[Amily2-Renderer] Renderer has been initialized on-demand.");
        }

        if (isChecked) {
            renderAllIframes();
        } else {
            clearAllIframes();
        }
    });

    container.on('change', '#render-depth', function () {
        const depth = parseInt(this.value, 10);
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {};
        }
        extension_settings[extensionName].render_depth = depth;
        saveSettingsDebounced();

        toastr.success(`渲染深度已保存为: ${depth}`);
    });

    console.log("[Amily2-Renderer] Renderer UI events have been successfully bound.");
}
