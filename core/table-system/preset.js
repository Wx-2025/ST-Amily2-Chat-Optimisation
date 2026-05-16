/**
 * @file 表格预设的导入 / 导出 / 全局预设管理。
 *
 * 历史来源：从 manager.js 抽出
 *   - exportPreset / exportPresetFull       → 调内部 exportPresetBase
 *   - importPreset                          → 接受 hooks 注入 SuperMemory 同步等副作用
 *   - clearGlobalPreset                     → 清除 extension_settings 中的全局预设
 *   - importGlobalPreset                    → 写入全局预设
 *
 * 设计要点：
 *   - 不内含 SuperMemory dispatch 逻辑（避免与 manager.js 循环依赖）
 *   - importPreset 接受 hooks: { onAfterApply, onImported }，调用方注入需要的副作用
 *   - 所有持久化走 infra/persistence.js，不再复制 saveStateToMessage 样板
 */

import { extension_settings, getContext } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';
import { extensionName } from '../../utils/settings.js';
import { log } from './logger.js';
import { getState, setState } from './infra/store.js';
import { saveStateToMessage, commitToLastMessage } from './infra/persistence.js';
import {
    getBatchFillerRuleTemplate,
    getBatchFillerFlowTemplate,
    saveBatchFillerRuleTemplate,
    saveBatchFillerFlowTemplate,
    saveAiTemplate,
} from './templates.js';

/**
 * @typedef {{
 *   onAfterApply?: () => void,
 *   onImported?: () => void
 * }} ImportPresetHooks
 */

// ── 导出 ──────────────────────────────────────────────────────────────────

/**
 * @param {boolean} includeData 是否包含 rows 实际数据
 */
function exportPresetBase(includeData = false) {
    const state = getState();
    if (!state) {
        log('无法导出：当前表格状态为空。', 'error');
        toastr.error('没有可导出的表格数据。');
        return;
    }

    let tablesToExport;
    let fileNameSuffix;

    if (includeData) {
        // 完整备份
        tablesToExport = JSON.parse(JSON.stringify(state));
        fileNameSuffix = '完整备份';
    } else {
        // 纯净预设：仅结构 + 规则，不带数据
        tablesToExport = state.map(table => ({
            name: table.name,
            headers: table.headers,
            columnWidths: table.columnWidths || [],
            note: table.note,
            rule_add: table.rule_add,
            rule_delete: table.rule_delete,
            rule_update: table.rule_update,
            charLimitRules: table.charLimitRules || {},
            rowLimitRule: table.rowLimitRule || 0,
            // simplifyRowThreshold 不导出：与当前聊天进度强绑定的临时设置
            rows: [],
            rowStatuses: [],
        }));
        fileNameSuffix = '纯净预设';
    }

    const preset = {
        version: 'Amily2-Table-Preset-v3.0-separated_templates',
        batchFillerRuleTemplate: getBatchFillerRuleTemplate(),
        batchFillerFlowTemplate: getBatchFillerFlowTemplate(),
        tables: tablesToExport,
    };

    const blob = new Blob([JSON.stringify(preset, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Amily2-${fileNameSuffix}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    log(`【${fileNameSuffix}】已成功导出。`, 'success');
    toastr.success(`【${fileNameSuffix}】已开始下载。`, '导出成功');
}

export function exportPreset() {
    exportPresetBase(false);
}

export function exportPresetFull() {
    exportPresetBase(true);
}

// ── 导入 ──────────────────────────────────────────────────────────────────

/**
 * 把导入的 tables 数组归一化（补字段 + 兼容旧版结构）。in-place mutation。
 */
function _normalizeImportedTables(importedTables) {
    importedTables.forEach(table => {
        if (table.name === undefined || table.headers === undefined || table.rows === undefined) {
            throw new Error(`导入的表格数据格式不正确: ${JSON.stringify(table)}`);
        }
        if (table.note === undefined) table.note = '无';
        if (table.rule_add === undefined) table.rule_add = '允许';
        if (table.rule_delete === undefined) table.rule_delete = '允许';
        if (table.rule_update === undefined) table.rule_update = '允许';

        // 多列规则兼容：旧 charLimitRule 单列对象 → 新 charLimitRules 对象映射
        if (table.charLimitRule && !table.charLimitRules) {
            table.charLimitRules = {};
            if (table.charLimitRule.columnIndex !== -1 && table.charLimitRule.limit > 0) {
                table.charLimitRules[table.charLimitRule.columnIndex] = table.charLimitRule.limit;
            }
        } else if (table.charLimitRules === undefined) {
            table.charLimitRules = {};
        }
        delete table.charLimitRule;

        // 延迟删除：rowStatuses 必须存在
        if (!table.rowStatuses) {
            table.rowStatuses = Array(table.rows.length).fill('normal');
        }
        if (table.rowLimitRule === undefined) table.rowLimitRule = 0;
        if (table.columnWidths === undefined) table.columnWidths = [];
    });
}

/**
 * 把导入的预设里的模板字段写回 extension_settings。版本兼容三档：
 * v3.0(separated) / v2.1(aiRule+aiFlow) / v2.0(aiTemplate)
 */
function _applyImportedTemplates(preset) {
    if (preset.version === 'Amily2-Table-Preset-v3.0-separated_templates') {
        saveBatchFillerRuleTemplate(preset.batchFillerRuleTemplate || '');
        saveBatchFillerFlowTemplate(preset.batchFillerFlowTemplate || '');
        saveAiTemplate(preset.injectionFlowTemplate || '');
    } else if (preset.aiRuleTemplate !== undefined && preset.aiFlowTemplate !== undefined) {
        saveBatchFillerRuleTemplate(preset.aiRuleTemplate || '');
        saveBatchFillerFlowTemplate(preset.aiFlowTemplate || '');
        saveAiTemplate(preset.aiFlowTemplate || '');
    } else if (preset.aiTemplate) {
        saveBatchFillerRuleTemplate('');
        saveBatchFillerFlowTemplate(preset.aiTemplate || '');
        saveAiTemplate(preset.aiTemplate || '');
    } else {
        log('导入的预设中缺少指令模板字段，模板将不会被更新。', 'warn');
    }
}

/**
 * 弹出文件选择 → 解析 JSON → 归一化 → 写入 store + 持久化。
 *
 * hooks.onAfterApply 在 setState 之后、saveChat 之前触发（用于注入 SuperMemory 同步等副作用）。
 * hooks.onImported 在全部完成后触发（UI 刷新）。
 *
 * @param {ImportPresetHooks | (() => void)} [hooksOrCallback] 兼容旧签名 importPreset(callback)
 */
export function importPreset(hooksOrCallback) {
    /** @type {ImportPresetHooks} */
    const hooks = typeof hooksOrCallback === 'function'
        ? { onImported: hooksOrCallback }
        : (hooksOrCallback || {});

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = event => {
            try {
                const preset = JSON.parse(event.target.result);

                if (!preset.version || !Array.isArray(preset.tables)) {
                    throw new Error('文件格式无效或缺少版本号/表格数据。');
                }

                const confirmation = window.confirm(
                    '【警告】\n\n导入操作将完全覆盖您当前的AI指令模板和所有表格（包括结构和内容）。\n\n此操作不可逆，是否确定要继续？'
                );
                if (!confirmation) {
                    log('用户取消了导入操作。', 'info');
                    toastr.info('导入操作已取消。');
                    return;
                }

                _applyImportedTemplates(preset);

                const importedTables = preset.tables;
                _normalizeImportedTables(importedTables);

                setState(importedTables);

                // 钩子：让调用方注入 SuperMemory 全量同步等副作用
                if (typeof hooks.onAfterApply === 'function') {
                    try { hooks.onAfterApply(); } catch (e) {
                        log(`importPreset onAfterApply 抛错: ${e.message}`, 'error');
                    }
                }

                commitToLastMessage(getState());
                log('导入的预设已强制写入最新消息并立即保存。', 'success');
                log('预设已成功导入并应用。', 'success');
                toastr.success('预设已成功导入！', '导入成功');

                if (typeof hooks.onImported === 'function') {
                    try { hooks.onImported(); } catch (e) {
                        log(`importPreset onImported 抛错: ${e.message}`, 'error');
                    }
                }
            } catch (error) {
                log(`导入预设失败: ${error.message}`, 'error');
                toastr.error(`导入失败：${error.message}`, '错误');
            }
        };
        reader.readAsText(file);
    };

    input.click();
}

// ── 全局预设 ──────────────────────────────────────────────────────────────

export function clearGlobalPreset() {
    if (extension_settings[extensionName] && extension_settings[extensionName].global_table_preset) {
        const confirmation = window.confirm(
            '【清除全局预设】\n\n您确定要清除已设置的全局预设吗？\n\n清除后，新聊天将恢复使用扩展内置的默认表格模板。'
        );

        if (confirmation) {
            delete extension_settings[extensionName].global_table_preset;
            saveSettingsDebounced();
            log('全局预设已被清除。', 'success');
            toastr.success('全局预设已清除，新聊天将使用默认模板。', '操作成功');
        } else {
            log('用户取消了清除全局预设的操作。', 'info');
            toastr.info('操作已取消。');
        }
    } else {
        log('无需清除，当前未设置任何全局预设。', 'info');
        toastr.info('当前没有设置全局预设。', '提示');
    }
}

/**
 * @param {(() => void) | undefined} onImported
 */
export function importGlobalPreset(onImported) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';

    input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = event => {
            try {
                const preset = JSON.parse(event.target.result);

                if (!preset.version || !Array.isArray(preset.tables)) {
                    throw new Error('文件格式无效或缺少版本号/表格数据。');
                }

                const confirmation = window.confirm(
                    '【全局预设导入】\n\n这将把选定的预设设置为所有新聊天的默认表格。\n\n此操作将覆盖任何已存在的全局预设，是否确定？'
                );
                if (!confirmation) {
                    log('用户取消了全局预设导入操作。', 'info');
                    toastr.info('操作已取消。');
                    return;
                }

                // 纯净副本：仅结构，不含 rows
                const cleanTables = preset.tables.map(table => ({
                    name: table.name,
                    headers: table.headers,
                    note: table.note,
                    rule_add: table.rule_add,
                    rule_delete: table.rule_delete,
                    rule_update: table.rule_update,
                    rows: [],
                }));

                if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
                extension_settings[extensionName].global_table_preset = {
                    version: preset.version,
                    tables: cleanTables,
                    batchFillerRuleTemplate: preset.batchFillerRuleTemplate,
                    batchFillerFlowTemplate: preset.batchFillerFlowTemplate,
                };
                saveSettingsDebounced();

                _applyImportedTemplates(preset);

                log('全局预设已成功导入并保存到扩展设置中。', 'success');
                toastr.success('全局预设已设置！新聊天将默认使用此预设。', '设置成功');

                if (typeof onImported === 'function') {
                    try { onImported(); } catch (e) {
                        log(`importGlobalPreset onImported 抛错: ${e.message}`, 'error');
                    }
                }
            } catch (error) {
                log(`导入全局预设失败: ${error.message}`, 'error');
                toastr.error(`导入失败：${error.message}`, '错误');
            }
        };
        reader.readAsText(file);
    };

    input.click();
}
