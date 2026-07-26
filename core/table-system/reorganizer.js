import { extension_settings, getContext } from "/scripts/extensions.js";
import { renderTables } from '../../ui/table-bindings.js';
import { extensionName } from "../../utils/settings.js";
import { convertAiFillableTablesToCsvString, convertSelectedAiFillableTablesToCsvString, updateTableFromText, getBatchFillerRuleTemplate, getBatchFillerFlowTemplate } from './manager.js';
import { getPresetPrompts, getMixedOrder } from '../../PresetSettings/index.js';
import { callAI, generateRandomSeed } from '../api.js';
import { callNccsAI } from '../api/NccsApi.js';
import {
    assertTableFillRequestLease,
    captureTableFillRequestLease,
    isTableFillRequestLeaseError,
} from './infra/persistence-scope.js';

export async function reorganizeTableContent(selectedTableIndices) {
    const settings = extension_settings[extensionName] || {};

    if (settings.table_system_enabled === false) {
        toastr.warning('表格系统总开关已关闭。');
        return;
    }

    if (window.AMILY2_SYSTEM_PARALYZED === true) {
        console.error("[Amily2-制裁] 系统完整性已受损，所有外交活动被无限期中止。");
        return;
    }

    try {
        const context = getContext();
        // Reorganization emits numeric legacy commands derived from the
        // current table snapshot. It has no message-floor target, so bind the
        // exact chat source and table lease without inventing target evidence.
        const requestLease = captureTableFillRequestLease(context);
        toastr.info('正在重新整理表格内容...', 'Amily2-重新整理');
        
        let currentTableDataString;
        if (selectedTableIndices && Array.isArray(selectedTableIndices) && selectedTableIndices.length > 0) {
            currentTableDataString = convertSelectedAiFillableTablesToCsvString(selectedTableIndices);
        } else {
            currentTableDataString = convertAiFillableTablesToCsvString();
        }

        if (!currentTableDataString.trim()) {
            toastr.warning('当前没有表格内容需要整理。', 'Amily2-重新整理');
            return;
        }

        const order = getMixedOrder('reorganizer') || [];
        const presetPrompts = await getPresetPrompts('reorganizer');
        
        const messages = [
            { role: 'system', content: generateRandomSeed() }
        ];

        const ruleTemplate = getBatchFillerRuleTemplate();
        const flowTemplate = getBatchFillerFlowTemplate();
        const finalFlowPrompt = flowTemplate.replace('{{{Amily2TableData}}}', currentTableDataString);

        let promptCounter = 0; 
        for (const item of order) {
            if (item.type === 'prompt') {
                if (presetPrompts && presetPrompts[promptCounter]) {
                    messages.push(presetPrompts[promptCounter]);
                    promptCounter++; 
                }
            } else if (item.type === 'conditional') {
                switch (item.id) {
                    case 'flowTemplate':
                        messages.push({ role: "system", content: finalFlowPrompt });
                        break;
                }
            }
        }

        console.groupCollapsed(`[Amily2 重新整理] 即将发送至 API 的内容`);
        console.dir(messages);
        console.groupEnd();

        assertTableFillRequestLease(requestLease, getContext());
        let rawContent;
        if (settings.nccsEnabled) {
            console.log('[Amily2-重新整理] 使用独立API填表进行表格重整...');
            rawContent = await callNccsAI(messages);
        } else {
            console.log('[Amily2-重新整理] 使用 tableFilling slot 进行表格重整...');
            rawContent = await callAI(messages, { slot: 'tableFilling' });
        }
        assertTableFillRequestLease(requestLease, getContext());

        if (!rawContent) {
            console.error('[Amily2-重新整理] 未能获取AI响应内容。');
            return;
        }

        console.log("[Amily2号-重新整理-原始回复]:", rawContent);
        const applied = await updateTableFromText(rawContent, {
            requestLease,
            sourceMessages: context.chat,
        });
        if (!applied) {
            throw new Error('AI 响应未产生可提交变更，或表格保存失败。');
        }
        renderTables();
        
        toastr.success('表格内容重新整理完成！', 'Amily2-重新整理');
    } catch (error) {
        if (isTableFillRequestLeaseError(error)) {
            console.warn('[Amily2-重新整理] 聊天或表格状态已变化，过期结果已丢弃。', error);
            toastr.warning('聊天或表格已变化，本次重新整理结果已安全丢弃。', '重新整理已停止');
            return;
        }
        console.error('[Amily2-重新整理] 发生错误:', error);
        toastr.error(`重新整理失败: ${error.message}`, 'Amily2-重新整理');
    }
}
