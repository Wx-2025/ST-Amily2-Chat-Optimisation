import { extensionName } from "../../utils/settings.js";
import { extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced, eventSource, event_types } from "/script.js";
import { initializeSuperMemory, purgeSuperMemory, forceSyncAll } from "./manager.js";
import { defaultSettings as ragDefaultSettings } from "../rag-settings.js";
import { getMemoryState } from "../table-system/manager.js";

const RAG_MODULE_NAME = 'hanlinyuan-rag-core';

function getRagSettings() {
    if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
    const root = extension_settings[extensionName];
    if (!root[RAG_MODULE_NAME]) {
        root[RAG_MODULE_NAME] = structuredClone(ragDefaultSettings);
    }
    return root[RAG_MODULE_NAME];
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
            // 【修复】启动时若开关为关，initializeSuperMemory 会早退且不注册监听器；
            // 旧实现勾选后只写设置不初始化，导致开关"打开了但没反应"直到刷新页面。
            // initializeSuperMemory 幂等（isInitialized 防重入），此处直接补初始化。
            if (this.checked) {
                initializeSuperMemory();
            }
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
        if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
        const id = this.id;

        // SuperMemory 自身设置
        if (id === 'sm-min-trigger-floor') {
            extension_settings[extensionName]['superMemory_minTriggerFloor'] = Math.max(0, parseInt(this.value, 10) || 0);
            saveSettingsDebounced();
            console.log(`[Amily2-SuperMemory] Input updated: ${id} = ${this.value}`);
            return;
        }

        // RAG 归档设置
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
        const type = $(this).data('type'); // 'sync' | 'constant' | 'pinFirstRow'
        const checked = this.checked;

        if (!extension_settings[extensionName].superMemory_tableSettings[tableName]) {
            extension_settings[extensionName].superMemory_tableSettings[tableName] = {};
        }

        extension_settings[extensionName].superMemory_tableSettings[tableName][type] = checked;
        saveSettingsDebounced();
        // 立即应用：首行常驻切换需要把该行详情条目在 蓝灯/绿灯 之间重写
        forceSyncAll();
        console.log(`[Amily2-SuperMemory] Table setting updated: ${tableName}.${type} = ${checked}`);
    });

    loadSuperMemorySettings();

    // 切聊天后面板内容刷新：面板的表格列表只在挂载时渲染一次、之后仅靠手动「刷新表格列表」按钮，
    // 无 CHAT_CHANGED 监听 → 切换同卡不同聊天后列表停在旧聊天。这里补上：
    // 仅当面板可见时刷新；延后到表格系统的 loadTables（index.js 中 CHAT_CHANGED 后 100ms）之后，
    // 否则会渲染出尚未更新的旧 state（同 super-memory 同步那处规避的竞态）。
    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (!panel.is(':visible')) return;
        setTimeout(refreshSuperMemoryPanel, 300);
    });

    console.log('[Amily2-SuperMemory] Events bound successfully.');
}

/**
 * 刷新超级记忆面板的动态内容（表格列表）。供「打开面板」与「切聊天」复用。
 * 仅重渲染随聊天变化的部分；全局开关/阈值等设置不随聊天变，无需重读。
 */
export function refreshSuperMemoryPanel() {
    const panel = $('#amily2_super_memory_panel');
    if (panel.length === 0) return;
    renderTableSettingsList();
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
        
        // Default values: Sync=True, Constant=True; PinFirstRow=False
        const isSyncEnabled = tableConfig.sync !== false;
        const isConstant = tableConfig.constant !== false;
        const isPinFirstRow = tableConfig.pinFirstRow === true;

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
                <div style="display: flex; justify-content: flex-start; margin-top: 5px;">
                    <div style="display: flex; align-items: center;">
                        <label class="sm-toggle-switch" style="transform: scale(0.8); margin-right: 5px;">
                            <input type="checkbox" class="sm-table-setting-check" data-table="${tableName}" data-type="pinFirstRow" ${isPinFirstRow ? 'checked' : ''}>
                            <span class="sm-slider"></span>
                        </label>
                        <span style="font-size: 0.9em; color: #ccc;" title="第一行通常是总调/全局定义行，开启后升为常驻注入，不再依赖关键词触发">首行常驻</span>
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
    $('#sm-min-trigger-floor').val(settings.superMemory_minTriggerFloor ?? 0);

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
