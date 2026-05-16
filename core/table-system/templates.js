/**
 * @file 表格 prompt 模板的 getter/setter 集中点。
 *
 * 三套模板：
 *   - batch_filler_rule_template  规则模板（系统提示词部分）
 *   - batch_filler_flow_template  流程模板（含 {{{Amily2TableData}}} 占位符）
 *   - amily2_ai_template          注入模板（主 API 模式下走的注入）
 *
 * 所有读写都落到 extension_settings[extensionName]，saveSettingsDebounced 触发持久化。
 *
 * 历史来源：从 manager.js 抽出
 *   - getBatchFillerRuleTemplate / saveBatchFillerRuleTemplate
 *   - getBatchFillerFlowTemplate / saveBatchFillerFlowTemplate
 *   - getAiFlowTemplateForInjection
 *   - saveAiTemplate / getAiTemplate
 */

import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';
import { extensionName } from '../../utils/settings.js';
import { DEFAULT_AI_RULE_TEMPLATE, DEFAULT_AI_FLOW_TEMPLATE } from './settings.js';

/**
 * @returns {string}
 */
export function getBatchFillerRuleTemplate() {
    return extension_settings[extensionName]?.batch_filler_rule_template ?? DEFAULT_AI_RULE_TEMPLATE;
}

/**
 * @param {string} template
 */
export function saveBatchFillerRuleTemplate(template) {
    if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
    extension_settings[extensionName].batch_filler_rule_template = template;
    saveSettingsDebounced();
}

/**
 * @returns {string}
 */
export function getBatchFillerFlowTemplate() {
    return extension_settings[extensionName]?.batch_filler_flow_template ?? DEFAULT_AI_FLOW_TEMPLATE;
}

/**
 * @param {string} template
 */
export function saveBatchFillerFlowTemplate(template) {
    if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
    extension_settings[extensionName].batch_filler_flow_template = template;
    saveSettingsDebounced();
}

/**
 * 主 API 模式下注入用的流程模板。与 batch_filler_flow_template 是两套独立配置。
 * @returns {string}
 */
export function getAiFlowTemplateForInjection() {
    return extension_settings[extensionName]?.amily2_ai_template ?? DEFAULT_AI_FLOW_TEMPLATE;
}

/**
 * @param {string} template
 */
export function saveAiTemplate(template) {
    if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
    extension_settings[extensionName].amily2_ai_template = template;
    saveSettingsDebounced();
}

/**
 * 别名 —— 历史 manager.js 同名函数，等价于 getAiFlowTemplateForInjection。
 * @returns {string}
 */
export function getAiTemplate() {
    return getAiFlowTemplateForInjection();
}
