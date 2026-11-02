
import { setExtensionPrompt } from '/script.js';
import { extension_settings, getContext } from '/scripts/extensions.js';
import { getBatchFillerFlowTemplate, convertTablesToCsvString, convertTablesToCsvStringForContentOnly, getMemoryState, setMemoryState, triggerSync } from './manager.js';
import { commitToLastMessageAsync } from './infra/persistence.js';
import { applyPendingRecordDeletions, hasPendingRecordDeletions } from './module-tables.js';
import { tableSystemDefaultSettings } from './settings.js';
import { extensionName } from '../../utils/settings.js';
import { log } from './logger.js';
import { renderTables } from '../../ui/table-bindings.js';
import { updateOrInsertTableInChat } from '../../ui/message-table-renderer.js';
import { getChatContextEpoch } from './infra/chat-scope.js';
import { getActiveTableGroupId } from './table-group-selection.js';
import { getModuleAccessDecision } from '../../utils/module-access-policy.js';

const INJECTION_KEY = 'AMILY2_TABLE_SYSTEM';
export function generateTableContent() {
    const settings = extension_settings[extensionName] || {};
    let injectionContent = '';

    if (settings.table_system_enabled === false || !settings.table_injection_enabled) {
        return '';
    }

    try {
        const tableGroupId = getActiveTableGroupId(getChatContextEpoch());
        if (!getModuleAccessDecision('Table').allowed) return '';
        const fillingMode = settings.filling_mode || 'main-api';

        if (fillingMode === 'secondary-api') {
            const contentOnlyTemplate = "##以下内容是故事发生的剧情中提取出的内容，已经转化为表格形式呈现给你，请将以下内容作为后续剧情的一部分参考：\n{{{Amily2TableDataContent}}}";
            const dataString = convertTablesToCsvStringForContentOnly(tableGroupId);
            if (dataString.trim()) {
                injectionContent = contentOnlyTemplate.replace('{{{Amily2TableDataContent}}}', dataString);
            }
        } else if (fillingMode === 'optimized') {
            const contentOnlyTemplate = "##以下内容是故事发生的剧情中提取出的内容，已经转化为表格形式呈现给你，请将以下内容作为后续剧情的一部分参考：\n{{{Amily2TableDataContent}}}";
            const dataString = convertTablesToCsvStringForContentOnly(tableGroupId);
            if (dataString.trim()) {
                injectionContent = contentOnlyTemplate.replace('{{{Amily2TableDataContent}}}', dataString);
            }
        }
        else { 
            const flowTemplate = getBatchFillerFlowTemplate();
            const dataString = convertTablesToCsvString(tableGroupId, { excludeAutomation: true });
            if (flowTemplate && dataString.trim()) {
                injectionContent = flowTemplate.replace('{{{Amily2TableData}}}', dataString);
            }
        }

        if (injectionContent.trim() && window.MiZheSi_Global?.isEnabled()) {
            injectionContent = `%%AMILY2_TABLE_INJECTION%%${injectionContent}`;
        }
    } catch (error) {
        console.warn('[Amily2] Table projection unavailable:', 'TABLE_PROJECTION_FAILED');
        return ''; 
    }

    return injectionContent;
}



export function hasPendingTableDataForGeneration(type) {
    return type !== 'quiet'
        && (extension_settings[extensionName] || {}).table_system_enabled !== false
        && getModuleAccessDecision('Table').allowed
        && hasPendingRecordDeletions(getMemoryState() || []);
}

// Run before acquiring the prompt's table revision, never during projection.
export async function prepareTableDataForGeneration(type) {
    if (!hasPendingTableDataForGeneration(type)) return false;
    const deletion = applyPendingRecordDeletions(getMemoryState() || []);
    if (!deletion.deletedCount) return false;
    const saved = await commitToLastMessageAsync(deletion.state, undefined, {
        publish: state => setMemoryState(state),
    });
    if (!saved) throw Object.assign(new Error('TABLE_GENERATION_PREPARATION_FAILED'), {
        code: 'TABLE_GENERATION_PREPARATION_FAILED',
    });
    log(`【延迟删除】已在注入前提交 ${deletion.deletedCount} 条待删除行并永久保存状态。`, 'info');
    try {
        triggerSync();
        renderTables();
        updateOrInsertTableInChat();
    } catch (error) {
        console.warn('[Amily2-延迟删除] 保存已完成，界面刷新失败。');
    }
    return true;
}

export async function injectTableData(chat, contextSize, abort, type) {
    const masterOff = (extension_settings[extensionName] || {}).table_system_enabled === false;
    if (masterOff) {
        setExtensionPrompt(INJECTION_KEY, '', 0, 0, false, 'SYSTEM');
        return;
    }

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



    try {
        let injectionContent = generateTableContent();

        if (!settings.table_injection_enabled) {
            setExtensionPrompt(INJECTION_KEY, '', 0, 0, false, 'SYSTEM');
            return;
        }

        if (!injectionContent || injectionContent.trim() === '') {
             // 理论上不会走到这里，除非宏都没了
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
