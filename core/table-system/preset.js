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

import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';
import { extensionName } from '../../utils/settings.js';
import { log } from './logger.js';
import { getState, setState } from './infra/store.js';
import { commitToLastMessageAsync } from './infra/persistence.js';
import { isSafeCharacterProfileEnvelope } from './character-profile.js';
import { isTableDefinitionRegistered, validateTableState } from './module-tables.js';
import {
    createCharacterPortableTableProfile,
    createTableProfile,
    createTableStateFromProfile,
    materializeTableProfile,
    normalizeTableProfile,
} from './profile.js';
import {
    getBatchFillerRuleTemplate,
    getBatchFillerFlowTemplate,
    getAiFlowTemplateForInjection,
    getCurrentTableTemplateSnapshot,
    getGlobalTableTemplateSnapshot,
    saveBatchFillerRuleTemplate,
    saveBatchFillerFlowTemplate,
    saveAiTemplate,
    saveGlobalBatchFillerRuleTemplate,
    saveGlobalBatchFillerFlowTemplate,
    saveGlobalAiTemplate,
} from './templates.js';

const SUPPORTED_LEGACY_PRESET_VERSIONS = new Set([
    'Amily2-Table-Preset-v2.0-clean',
    'Amily2-Table-Preset-v2.0-full',
    'Amily2-Table-Preset-v2.1',
    'Amily2-Table-Preset-v3.0-separated_templates',
]);

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

    const userTables = state.filter(table => table?.owner === undefined
        || (table.owner === 'user' && !isTableDefinitionRegistered(table.id)));
    if (userTables.length !== state.length) {
        toastr.info('模块归属表由各模块独立维护，本次预设导出未包含这些表。');
    }

    let tablesToExport;
    let fileNameSuffix;

    if (includeData) {
        // 完整备份
        tablesToExport = JSON.parse(JSON.stringify(userTables));
        fileNameSuffix = '完整备份';
    } else {
        // 纯净预设：仅结构 + 规则，不带数据
        tablesToExport = createCharacterPortableTableProfile(userTables).tables;
        fileNameSuffix = '纯净预设';
    }

    const preset = {
        version: 'Amily2-Table-Preset-v3.0-separated_templates',
        batchFillerRuleTemplate: getBatchFillerRuleTemplate(),
        batchFillerFlowTemplate: getBatchFillerFlowTemplate(),
        injectionFlowTemplate: getAiFlowTemplateForInjection(),
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

function _extractPresetTemplates(preset) {
    if (preset?.format === 'amily2.table-profile') {
        return { ...(preset.templates || {}) };
    }
    if (preset?.version === 'Amily2-Table-Preset-v3.0-separated_templates') {
        return Object.fromEntries([
            ['batchFillerRuleTemplate', preset.batchFillerRuleTemplate],
            ['batchFillerFlowTemplate', preset.batchFillerFlowTemplate],
            ['injectionFlowTemplate', preset.injectionFlowTemplate],
        ].filter(([, value]) => typeof value === 'string'));
    }
    if (preset?.aiRuleTemplate !== undefined && preset?.aiFlowTemplate !== undefined) {
        return {
            batchFillerRuleTemplate: preset.aiRuleTemplate || '',
            batchFillerFlowTemplate: preset.aiFlowTemplate || '',
            injectionFlowTemplate: preset.aiFlowTemplate || '',
        };
    }
    if (preset?.aiTemplate) {
        return {
            batchFillerRuleTemplate: '',
            batchFillerFlowTemplate: preset.aiTemplate || '',
            injectionFlowTemplate: preset.aiTemplate || '',
        };
    }
    return {};
}

function _assertUserOwnedPortableProfile(profile) {
    if (!isSafeCharacterProfileEnvelope(profile)) {
        throw new Error('表格档案损坏、超限，或携带了不允许的运行时行数据。');
    }
    if (profile.tables.some(table => table.owner !== 'user' || isTableDefinitionRegistered(table.id))) {
        throw new Error('普通预设不得声明或覆盖模块所有的表格。');
    }
}

function _resolveImportedProfile(preset, options = {}) {
    const fallbackTemplates = options.fallbackTemplates || getCurrentTableTemplateSnapshot();
    const source = options.source || 'import';
    const portable = normalizeTableProfile(preset);
    if (portable) {
        const profile = materializeTableProfile(
            portable,
            fallbackTemplates,
            { source, importedAt: new Date().toISOString() },
        );
        _assertUserOwnedPortableProfile(profile);
        const tables = validateTableState(createTableStateFromProfile(profile));
        return {
            profile,
            tables,
        };
    }
    if (!preset?.version || !Array.isArray(preset.tables)) {
        throw new Error('文件格式无效：需要 Amily2 TableProfile 或带版本号的传统表格预设。');
    }
    if (!SUPPORTED_LEGACY_PRESET_VERSIONS.has(preset.version)) {
        throw new Error(`不支持的表格预设版本：${String(preset.version)}`);
    }
    const tables = JSON.parse(JSON.stringify(preset.tables));
    _normalizeImportedTables(tables);
    const validatedTables = validateTableState(tables);
    const profile = materializeTableProfile(createTableProfile(validatedTables, {
            id: `imported-table-profile-${Date.now()}`,
            name: '导入的表格档案',
            templates: _extractPresetTemplates(preset),
        }), fallbackTemplates, {
        source,
        importedAt: new Date().toISOString(),
    });
    _assertUserOwnedPortableProfile(profile);
    return {
        profile,
        tables: validatedTables,
    };
}

/**
 * 弹出文件选择 → 解析 JSON → 归一化 → 写入 store + 持久化。
 *
 * hooks.onAfterApply 在状态成功持久化并写入 store 后触发（用于注入 SuperMemory 同步等副作用）。
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
        reader.onload = async event => {
            try {
                const preset = JSON.parse(event.target.result);

                const imported = _resolveImportedProfile(preset, {
                    fallbackTemplates: getCurrentTableTemplateSnapshot(),
                    source: 'import',
                });

                const confirmation = window.confirm(
                    '【警告】\n\n导入操作将覆盖当前 AI 指令模板和所有用户表（包括结构和内容），模块独立维护的表不会被覆盖。\n\n此操作不可逆，是否确定要继续？'
                );
                if (!confirmation) {
                    log('用户取消了导入操作。', 'info');
                    toastr.info('导入操作已取消。');
                    return;
                }

                const moduleTables = (getState() || [])
                    .filter(table => (table?.owner && table.owner !== 'user')
                        || isTableDefinitionRegistered(table?.id))
                    .map(table => JSON.parse(JSON.stringify(table)));
                const nextState = validateTableState([...imported.tables, ...moduleTables]);

                if (!await commitToLastMessageAsync(nextState, imported.profile)) {
                    throw new Error('当前聊天无法原子持久化导入的表格档案。');
                }
                setState(nextState);
                _applyImportedTemplates({
                    version: 'Amily2-Table-Preset-v3.0-separated_templates',
                    ...imported.profile.templates,
                });

                // 钩子：让调用方注入 SuperMemory 全量同步等副作用
                if (typeof hooks.onAfterApply === 'function') {
                    try { await hooks.onAfterApply(); } catch (e) {
                        log(`importPreset onAfterApply 抛错: ${e.message}`, 'error');
                    }
                }

                log('导入的预设已强制写入最新消息并立即保存。', 'success');
                log('预设已成功导入并应用。', 'success');
                toastr.success('预设已成功导入！', '导入成功');

                if (typeof hooks.onImported === 'function') {
                    try { await hooks.onImported(); } catch (e) {
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

                const imported = _resolveImportedProfile(preset, {
                    fallbackTemplates: getGlobalTableTemplateSnapshot(),
                    source: 'global',
                });
                const globalProfile = imported.profile;

                const confirmation = window.confirm(
                    '【全局预设导入】\n\n这将把选定的预设设置为所有新聊天的默认表格。\n\n此操作将覆盖任何已存在的全局预设，是否确定？'
                );
                if (!confirmation) {
                    log('用户取消了全局预设导入操作。', 'info');
                    toastr.info('操作已取消。');
                    return;
                }

                if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
                extension_settings[extensionName].global_table_preset = {
                    version: 'Amily2-Table-Profile-v1',
                    tables: globalProfile.tables,
                    tableProfile: globalProfile,
                    batchFillerRuleTemplate: globalProfile.templates.batchFillerRuleTemplate,
                    batchFillerFlowTemplate: globalProfile.templates.batchFillerFlowTemplate,
                    injectionFlowTemplate: globalProfile.templates.injectionFlowTemplate,
                };
                saveGlobalBatchFillerRuleTemplate(globalProfile.templates.batchFillerRuleTemplate || '');
                saveGlobalBatchFillerFlowTemplate(globalProfile.templates.batchFillerFlowTemplate || '');
                saveGlobalAiTemplate(globalProfile.templates.injectionFlowTemplate || '');
                saveSettingsDebounced();

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
