import { extensionName } from "../../utils/settings.js";
import { extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced } from "/script.js";
import { initializeSuperMemory, purgeSuperMemory } from "./manager.js";
import { defaultSettings as ragDefaultSettings } from "../rag-settings.js";

const RAG_MODULE_NAME = 'hanlinyuan-rag-core';

function getRagSettings() {
    if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
    if (!extension_settings[extensionName][RAG_MODULE_NAME]) {
        extension_settings[extensionName][RAG_MODULE_NAME] = structuredClone(ragDefaultSettings);
    }
    return extension_settings[extensionName][RAG_MODULE_NAME];
}

export function bindSuperMemoryEvents() {
    const panel = $('#amily2_super_memory_panel');
    if (panel.length === 0) return;

    panel.on('click', '.sm-nav-item', function() {
        const tab = $(this).data('tab');
        
        panel.find('.sm-nav-item').removeClass('active');
        $(this).addClass('active');

        panel.find('.sm-tab-pane').removeClass('active');
        panel.find(`#sm-${tab}-tab`).addClass('active');
    });

    // 处理 Checkbox 变更
    panel.on('change', 'input[type="checkbox"]', function() {
        if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
        
        const id = this.id;
        
        // Super Memory 自身设置
        if (id === 'sm-system-enabled') {
            extension_settings[extensionName]['super_memory_enabled'] = this.checked;
            saveSettingsDebounced();
            return;
        }
        if (id === 'sm-bridge-enabled') {
            extension_settings[extensionName]['superMemory_bridgeEnabled'] = this.checked;
            saveSettingsDebounced();
            return;
        }

        // RAG 设置 (归档 & 关联图谱)
        const ragSettings = getRagSettings();
        
        if (id === 'sm-archive-enabled') {
            if (!ragSettings.archive) ragSettings.archive = {};
            ragSettings.archive.enabled = this.checked;
        }
        else if (id === 'sm-relationship-graph-enabled') {
            if (!ragSettings.relationshipGraph) ragSettings.relationshipGraph = {};
            ragSettings.relationshipGraph.enabled = this.checked;
        }

        saveSettingsDebounced();
        console.log(`[Amily2-SuperMemory] Checkbox updated: ${id} = ${this.checked}`);
    });

    // 处理 Input 变更 (归档阈值等)
    panel.on('change', 'input[type="number"], input[type="text"]', function() {
        const id = this.id;
        const ragSettings = getRagSettings();
        if (!ragSettings.archive) ragSettings.archive = {};

        if (id === 'sm-archive-threshold') {
            ragSettings.archive.threshold = parseInt(this.value, 10);
        }
        else if (id === 'sm-archive-batch-size') {
            ragSettings.archive.batchSize = parseInt(this.value, 10);
        }
        else if (id === 'sm-archive-target-table') {
            ragSettings.archive.targetTable = this.value;
        }

        saveSettingsDebounced();
        console.log(`[Amily2-SuperMemory] Input updated: ${id} = ${this.value}`);
    });

    loadSuperMemorySettings();
    
    console.log('[Amily2-SuperMemory] Events bound successfully.');
}

function loadSuperMemorySettings() {
    const settings = extension_settings[extensionName] || {};
    const ragSettings = getRagSettings();
    
    // Super Memory 设置
    $('#sm-system-enabled').prop('checked', settings.super_memory_enabled ?? false); 
    $('#sm-bridge-enabled').prop('checked', settings.superMemory_bridgeEnabled ?? false); 

    // 归档设置
    if (ragSettings.archive) {
        $('#sm-archive-enabled').prop('checked', ragSettings.archive.enabled ?? false);
        $('#sm-archive-threshold').val(ragSettings.archive.threshold ?? 20);
        $('#sm-archive-batch-size').val(ragSettings.archive.batchSize ?? 10);
        $('#sm-archive-target-table').val(ragSettings.archive.targetTable ?? '总结表');
    }

    // 关联图谱设置
    if (ragSettings.relationshipGraph) {
        $('#sm-relationship-graph-enabled').prop('checked', ragSettings.relationshipGraph.enabled ?? false);
    }
}

window.sm_initializeSystem = async function() {
    toastr.info('超级记忆系统正在初始化...');
    $('#sm-system-status').text('初始化中...').css('color', 'yellow');
    
    try {
        await initializeSuperMemory();
        toastr.success('超级记忆系统初始化完成。');
    } catch (error) {
        console.error(error);
        toastr.error('初始化失败，请检查控制台。');
        $('#sm-system-status').text('错误').css('color', 'red');
    }
};

window.sm_purgeMemory = async function() {
    if (confirm('您确定要清空所有由Amily2管理的超级记忆数据吗？\n这将删除世界书中所有以表格世界书的条目。')) {
        toastr.info('正在清空记忆...');
        await purgeSuperMemory();
        $('#sm-system-status').text('已清空').css('color', '#ffc107');
    }
};
