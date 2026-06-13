/**
 * core/progressive-memory/bindings.js
 *
 * 渐进记忆面板的 UI 事件绑定与设置回填。
 * 设置统一存 extension_settings[extensionName].progressive_memory（纯 JSON）。
 */

import { extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced } from "/script.js";
import { extensionName } from "../../utils/settings.js";
import { progressiveMemoryDefaults } from "./engine.js";

function getStore() {
    if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
    const root = extension_settings[extensionName];
    if (!root.progressive_memory) {
        root.progressive_memory = structuredClone(progressiveMemoryDefaults.progressive_memory);
    }
    // 补齐缺失键（旧存档或部分写入）
    root.progressive_memory = {
        ...structuredClone(progressiveMemoryDefaults.progressive_memory),
        ...root.progressive_memory,
        injection: {
            ...progressiveMemoryDefaults.progressive_memory.injection,
            ...(root.progressive_memory.injection || {}),
        },
    };
    return root.progressive_memory;
}

export function bindProgressiveMemoryEvents() {
    const panel = $('#amily2_progressive_memory_panel');
    if (panel.length === 0) return;

    panel.on('change', '#pm-enabled', function () {
        getStore().enabled = this.checked;
        saveSettingsDebounced();
    });

    panel.on('change', '#pm-target-table', function () {
        getStore().targetTable = this.value.trim() || '总结表';
        saveSettingsDebounced();
    });

    const numMap = {
        'pm-recent': 'recentCount',
        'pm-mid': 'midCount',
        'pm-far': 'farCount',
    };
    panel.on('change', '#pm-recent, #pm-mid, #pm-far', function () {
        getStore()[numMap[this.id]] = Math.max(0, parseInt(this.value, 10) || 0);
        saveSettingsDebounced();
    });

    panel.on('change', '#pm-inj-position', function () {
        getStore().injection.position = Math.max(0, parseInt(this.value, 10) || 0);
        saveSettingsDebounced();
    });
    panel.on('change', '#pm-inj-depth', function () {
        getStore().injection.depth = Math.max(0, parseInt(this.value, 10) || 0);
        saveSettingsDebounced();
    });
    panel.on('change', '#pm-inj-role', function () {
        getStore().injection.role = parseInt(this.value, 10) || 0;
        saveSettingsDebounced();
    });

    panel.on('change', '#pm-template', function () {
        getStore().template = this.value;
        saveSettingsDebounced();
    });

    loadProgressiveMemorySettings();
    console.log('[Amily2-渐进记忆] 事件绑定完成。');
}

function loadProgressiveMemorySettings() {
    const s = getStore();
    $('#pm-enabled').prop('checked', s.enabled === true);
    $('#pm-target-table').val(s.targetTable);
    $('#pm-recent').val(s.recentCount);
    $('#pm-mid').val(s.midCount);
    $('#pm-far').val(s.farCount);
    $('#pm-inj-position').val(s.injection.position);
    $('#pm-inj-depth').val(s.injection.depth);
    $('#pm-inj-role').val(String(s.injection.role));
    $('#pm-template').val(s.template);
}
