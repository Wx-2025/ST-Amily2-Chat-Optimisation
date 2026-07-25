/**
 * @file 表格 prompt 模板的 getter/setter 集中点。
 *
 * 三套模板：
 *   - batch_filler_rule_template  规则模板（系统提示词部分）
 *   - batch_filler_flow_template  流程模板（含 {{{Amily2TableData}}} 占位符）
 *   - amily2_ai_template          注入模板（主 API 模式下走的注入）
 *
 * v2 聊天优先读写 chatMetadata 中 TableProfile.templates；旧聊天继续读写
 * extension_settings，确保聊天快照 > 角色卡初始化快照 > 全局配置。
 *
 * 历史来源：从 manager.js 抽出
 *   - getBatchFillerRuleTemplate / saveBatchFillerRuleTemplate
 *   - getBatchFillerFlowTemplate / saveBatchFillerFlowTemplate
 *   - getAiFlowTemplateForInjection
 *   - saveAiTemplate / getAiTemplate
 */

import { extension_settings, getContext } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';
import { extensionName } from '../../utils/settings.js';
import { DEFAULT_AI_RULE_TEMPLATE, DEFAULT_AI_FLOW_TEMPLATE } from './settings.js';
import { getState } from './infra/store.js';
import { deepClone, persistChatTableState, readChatTableState } from './infra/database-state.js';

const PROFILE_TEMPLATE_KEYS = Object.freeze({
    rule: 'batchFillerRuleTemplate',
    flow: 'batchFillerFlowTemplate',
    injection: 'injectionFlowTemplate',
});

/**
 * @returns {string}
 */
export function getBatchFillerRuleTemplate() {
    return getActiveTemplate(
        PROFILE_TEMPLATE_KEYS.rule,
        getGlobalBatchFillerRuleTemplate(),
    );
}

/**
 * @param {string} template
 */
export function saveBatchFillerRuleTemplate(template) {
    saveActiveTemplate(PROFILE_TEMPLATE_KEYS.rule, template, saveGlobalBatchFillerRuleTemplate);
}

/**
 * @returns {string}
 */
export function getBatchFillerFlowTemplate() {
    return getActiveTemplate(
        PROFILE_TEMPLATE_KEYS.flow,
        getGlobalBatchFillerFlowTemplate(),
    );
}

/**
 * @param {string} template
 */
export function saveBatchFillerFlowTemplate(template) {
    saveActiveTemplate(PROFILE_TEMPLATE_KEYS.flow, template, saveGlobalBatchFillerFlowTemplate);
}

/**
 * 主 API 模式下注入用的流程模板。与 batch_filler_flow_template 是两套独立配置。
 * @returns {string}
 */
export function getAiFlowTemplateForInjection() {
    return getActiveTemplate(
        PROFILE_TEMPLATE_KEYS.injection,
        getGlobalAiFlowTemplateForInjection(),
    );
}

/**
 * @param {string} template
 */
export function saveAiTemplate(template) {
    saveActiveTemplate(PROFILE_TEMPLATE_KEYS.injection, template, saveGlobalAiTemplate);
}

export function getGlobalBatchFillerRuleTemplate() {
    return extension_settings[extensionName]?.batch_filler_rule_template ?? DEFAULT_AI_RULE_TEMPLATE;
}

export function saveGlobalBatchFillerRuleTemplate(template) {
    if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
    extension_settings[extensionName].batch_filler_rule_template = String(template ?? '');
    saveSettingsDebounced();
}

export function getGlobalBatchFillerFlowTemplate() {
    return extension_settings[extensionName]?.batch_filler_flow_template ?? DEFAULT_AI_FLOW_TEMPLATE;
}

export function saveGlobalBatchFillerFlowTemplate(template) {
    if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
    extension_settings[extensionName].batch_filler_flow_template = String(template ?? '');
    saveSettingsDebounced();
}

export function getGlobalAiFlowTemplateForInjection() {
    return extension_settings[extensionName]?.amily2_ai_template ?? DEFAULT_AI_FLOW_TEMPLATE;
}

export function saveGlobalAiTemplate(template) {
    if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
    extension_settings[extensionName].amily2_ai_template = String(template ?? '');
    saveSettingsDebounced();
}

export function getCurrentTableTemplateSnapshot() {
    return {
        [PROFILE_TEMPLATE_KEYS.rule]: getBatchFillerRuleTemplate(),
        [PROFILE_TEMPLATE_KEYS.flow]: getBatchFillerFlowTemplate(),
        [PROFILE_TEMPLATE_KEYS.injection]: getAiFlowTemplateForInjection(),
    };
}

export function getGlobalTableTemplateSnapshot() {
    return {
        [PROFILE_TEMPLATE_KEYS.rule]: getGlobalBatchFillerRuleTemplate(),
        [PROFILE_TEMPLATE_KEYS.flow]: getGlobalBatchFillerFlowTemplate(),
        [PROFILE_TEMPLATE_KEYS.injection]: getGlobalAiFlowTemplateForInjection(),
    };
}

/**
 * 别名 —— 历史 manager.js 同名函数，等价于 getAiFlowTemplateForInjection。
 * @returns {string}
 */
export function getAiTemplate() {
    return getAiFlowTemplateForInjection();
}

function getActiveTemplate(key, fallback) {
    const profile = readChatTableState(getContext())?.profile;
    const value = profile?.templates?.[key];
    return typeof value === 'string' ? value : fallback;
}

function saveActiveTemplate(key, template, saveGlobal) {
    const context = getContext();
    const envelope = readChatTableState(context);
    if (!envelope?.profile) {
        saveGlobal(template);
        return 'global';
    }

    const profile = deepClone(envelope.profile);
    profile.templates = {
        ...(profile.templates && typeof profile.templates === 'object' ? profile.templates : {}),
        [key]: String(template ?? ''),
    };
    persistChatTableState(context, getState() || envelope.tables, profile);
    return 'chat';
}
