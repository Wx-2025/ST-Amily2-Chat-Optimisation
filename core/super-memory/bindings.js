import { extensionName } from "../../utils/settings.js";
import { extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced } from "/script.js";
import { initializeSuperMemory, purgeSuperMemory } from "./manager.js";
import { defaultSettings as ragDefaultSettings } from "../rag-settings.js";
import { getMemoryState } from "../table-system/manager.js";

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
        if ($(this).hasClass('sm-table-setting-check')) return; // Skip table settings checks here

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

    // 绑定刷新表格列表按钮
    panel.on('click', '#sm-refresh-table-list', function() {
        renderTableSettingsList();
    });

    // 绑定表格专属配置的 Checkbox
    panel.on('change', '.sm-table-setting-check', function() {
        if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
        if (!extension_settings[extensionName].superMemory_tableSettings) {
            extension_settings[extensionName].superMemory_tableSettings = {};
        }

        const tableName = $(this).data('table');
        const type = $(this).data('type'); // 'sync' or 'constant'
        const checked = this.checked;

        if (!extension_settings[extensionName].superMemory_tableSettings[tableName]) {
            extension_settings[extensionName].superMemory_tableSettings[tableName] = {};
        }

        extension_settings[extensionName].superMemory_tableSettings[tableName][type] = checked;
        saveSettingsDebounced();
        console.log(`[Amily2-SuperMemory] Table setting updated: ${tableName}.${type} = ${checked}`);
    });

    loadSuperMemorySettings();
    
    console.log('[Amily2-SuperMemory] Events bound successfully.');
}

function renderTableSettingsList() {
    const container = $('#sm-table-settings-list');
    container.html('<div style="text-align: center; color: #888; padding: 20px;">正在加载...</div>');

    const tables = getMemoryState();
    if (!tables || tables.length === 0) {
        container.html('<div style="text-align: center; color: #888; padding: 20px;">暂无表格数据。请先在聊天中使用表格功能。</div>');
        return;
    }

    const settings = extension_settings[extensionName]?.superMemory_tableSettings || {};
    
    let html = '';
    tables.forEach(table => {
        const tableName = table.name;
        const tableConfig = settings[tableName] || {};
        
        // Default values: Sync=True, Constant=True
        const isSyncEnabled = tableConfig.sync !== false; 
        const isConstant = tableConfig.constant !== false;

        html += `
            <div class="sm-control-block" style="border-bottom: 1px solid rgba(255,255,255,0.1); padding-bottom: 10px; margin-bottom: 10px;">
                <div style="font-weight: bold; margin-bottom: 5px; color: #e0e0e0;">${tableName}</div>
                <div style="display: flex; justify-content: space-between;">
                    <div style="display: flex; align-items: center;">
                        <label class="sm-toggle-switch" style="transform: scale(0.8); margin-right: 5px;">
                            <input type="checkbox" class="sm-table-setting-check" data-table="${tableName}" data-type="sync" ${isSyncEnabled ? 'checked' : ''}>
                            <span class="sm-slider"></span>
                        </label>
                        <span style="font-size: 0.9em; color: #ccc;">写入世界书</span>
                    </div>
                    <div style="display: flex; align-items: center;">
                        <label class="sm-toggle-switch" style="transform: scale(0.8); margin-right: 5px;">
                            <input type="checkbox" class="sm-table-setting-check" data-table="${tableName}" data-type="constant" ${isConstant ? 'checked' : ''}>
                            <span class="sm-slider"></span>
                        </label>
                        <span style="font-size: 0.9em; color: #ccc;">索引绿灯(常驻)</span>
                    </div>
                </div>
            </div>
        `;
    });

    container.html(html);
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

    // 渲染表格列表
    renderTableSettingsList();
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
