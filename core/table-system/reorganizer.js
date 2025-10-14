import { getContext, extension_settings } from "/scripts/extensions.js";
import { saveChat } from "/script.js";
import { renderTables } from '../../ui/table-bindings.js';
import { extensionName } from "../../utils/settings.js";
import { convertTablesToCsvString, saveStateToMessage, getMemoryState, updateTableFromText, getBatchFillerRuleTemplate, getBatchFillerFlowTemplate } from './manager.js';
import { getPresetPrompts, getMixedOrder } from '../../PresetSettings/index.js';
import { callAI, generateRandomSeed } from '../api.js';
import { callNccsAI } from '../api/NccsApi.js';

export async function reorganizeTableContent() {
    const settings = extension_settings[extensionName];

    if (window.AMILY2_SYSTEM_PARALYZED === true) {
        console.error("[Amily2-制裁] 系统完整性已受损，所有外交活动被无限期中止。");
        return;
    }

    const { apiUrl, apiKey, model, temperature, maxTokens, forceProxyForCustomApi } = settings;
    if (!apiUrl || !model) {
        toastr.error("主API的URL或模型未配置，重新整理功能无法启动。", "Amily2-重新整理");
        return;
    }

    try {
        toastr.info('正在重新整理表格内容...', 'Amily2-重新整理');
        
        const currentTableDataString = convertTablesToCsvString();
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

        let rawContent;
        if (settings.nccsEnabled) {
            console.log('[Amily2-重新整理] 使用 Nccs API 进行表格重整...');
            rawContent = await callNccsAI(messages);
        } else {
            console.log('[Amily2-重新整理] 使用默认 API 进行表格重整...');
            rawContent = await callAI(messages);
        }

        if (!rawContent) {
            console.error('[Amily2-重新整理] 未能获取AI响应内容。');
            return;
        }

        console.log("[Amily2号-重新整理-原始回复]:", rawContent);
        updateTableFromText(rawContent);
        renderTables();
        
        toastr.success('表格内容重新整理完成！', 'Amily2-重新整理');
        const currentContext = getContext();
        if (currentContext.chat && currentContext.chat.length > 0) {
            saveChat();
        }

    } catch (error) {
        console.error('[Amily2-重新整理] 发生错误:', error);
        toastr.error(`重新整理失败: ${error.message}`, 'Amily2-重新整理');
    }
}
