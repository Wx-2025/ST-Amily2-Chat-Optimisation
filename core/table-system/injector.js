
import { setExtensionPrompt } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { getBatchFillerFlowTemplate, convertTablesToCsvString, convertTablesToCsvStringForContentOnly } from './manager.js';
import { tableSystemDefaultSettings } from './settings.js';
import { extensionName } from '../../utils/settings.js';

const INJECTION_KEY = 'AMILY2_TABLE_SYSTEM';

export function generateTableContent() {
    const settings = extension_settings[extensionName] || {};
    let injectionContent = '';

    if (!settings.table_injection_enabled) {
        return '';
    }

    try {

        const fillingMode = settings.filling_mode || 'main-api'; 

        if (fillingMode === 'secondary-api') {
            const contentOnlyTemplate = "##以下内容是故事发生的剧情中提取出的内容，已经转化为表格形式呈现给你，请将以下内容作为后续剧情的一部分参考：\n{{{Amily2TableDataContent}}}";
            const dataString = convertTablesToCsvStringForContentOnly();
            if (dataString.trim()) {
                injectionContent = contentOnlyTemplate.replace('{{{Amily2TableDataContent}}}', dataString);
            }
        } else if (fillingMode === 'optimized') {
            const contentOnlyTemplate = "##以下内容是故事发生的剧情中提取出的内容，已经转化为表格形式呈现给你，请将以下内容作为后续剧情的一部分参考：\n{{{Amily2TableDataContent}}}";
            const dataString = convertTablesToCsvStringForContentOnly();
            if (dataString.trim()) {
                injectionContent = contentOnlyTemplate.replace('{{{Amily2TableDataContent}}}', dataString);
            }
        }
        else { 
            const flowTemplate = getBatchFillerFlowTemplate();
            const dataString = convertTablesToCsvString();
            if (flowTemplate && dataString.trim()) {
                injectionContent = flowTemplate.replace('{{{Amily2TableData}}}', dataString);
            }
        }

        if (injectionContent.trim() && window.MiZheSi_Global?.isEnabled()) {
            injectionContent = `%%AMILY2_TABLE_INJECTION%%${injectionContent}`;
        }
    } catch (error) {
        console.error('[Amily2-表格内容生成器] 生成表格内容时发生错误:', error);
        return ''; 
    }

    return injectionContent;
}



export function injectTableData(chat, contextSize, abort, type) {

    if (window.AMILY2_MACRO_REPLACED === true) {
        console.log('[Amily2-表格注入器] 检测到宏已替换，跳过传统注入。');
        window.AMILY2_MACRO_REPLACED = false; 
        setExtensionPrompt(INJECTION_KEY, '', 0, 0, false, 'SYSTEM'); 
        return;
    }

    const settings = extension_settings[extensionName] || {};

    if (type === 'quiet') {
        return;
    }

    if (!settings.table_injection_enabled) {
        setExtensionPrompt(INJECTION_KEY, '', 0, 0, false, 'SYSTEM');
        return;
    }

    try {
        const injectionContent = generateTableContent();

        if (!injectionContent) {
            setExtensionPrompt(INJECTION_KEY, '', 0, 0, false, 'SYSTEM');
            return;
        }

        const injectionSettings = settings.injection || tableSystemDefaultSettings.injection;
        const position = parseInt(injectionSettings.position, 10);
        const depth = parseInt(injectionSettings.depth, 10);
        const role = parseInt(injectionSettings.role, 10);

        setExtensionPrompt(
            INJECTION_KEY,
            injectionContent,
            position,
            depth,
            false, 
            role
        );

        console.log(`[Amily2-表格注入器] 已成功注入表格数据 (位置: ${position}, 深度: ${depth}, 角色: ${role})。`);

    } catch (error) {
        console.error('[Amily2-表格注入器] 注入表格数据时发生错误:', error);
    }
}
