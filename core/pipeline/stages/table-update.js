/**
 * Pipeline Stage 3 — TableUpdate
 * 主 API 填表 + 按 Group 编排的自动分步填表。
 */
import { getContext, extension_settings } from '/scripts/extensions.js';
import { extensionName } from '../../../utils/settings.js';
import { processMessageUpdate } from '../../table-system/TableSystemService.js';
import { fillWithSecondaryApi } from '../../table-system/secondary-filler.js';
import { getMemoryState } from '../../table-system/manager.js';
import { isAiFillableTable } from '../../table-system/module-tables.js';
import { captureChatScope, chatScopesMatch } from '../../table-system/infra/chat-scope.js';
import {
    createTableGroupFillScope,
    normalizeTableGroupRegistry,
} from '../../table-system/table-groups.js';
import {
    isTableGroupAutomaticFillEnabled,
    readTableGroupRegistryFromContext,
} from '../../table-system/table-group-fill-settings.js';

function isSecondaryAutomaticMode() {
    const settings = extension_settings[extensionName] || {};
    return settings.table_system_enabled !== false && settings.filling_mode === 'secondary-api';
}

export async function tableUpdateStage(ctx, next) {
    const { messageId, latestMessage, chat } = ctx;
    const requestScope = captureChatScope(getContext());
    const isCurrent = () => {
        const context = getContext();
        return chatScopesMatch(requestScope, captureChatScope(context))
            && context.chat === chat
            && context.chat?.[messageId] === latestMessage;
    };
    if (!isCurrent()) return;
    const secondaryAutomatic = isSecondaryAutomaticMode();
    try {
        // 主 API 模式（secondary-api / optimized 模式下函数内部自行跳过）
        await processMessageUpdate(messageId);
    } catch (e) {
        console.error('[Pipeline:TableUpdate] 阶段异常:', e);
    }
    if (!isCurrent()) return;

    if (secondaryAutomatic && isSecondaryAutomaticMode()) {
        try {
            const registry = readTableGroupRegistryFromContext(getContext());
            const groupIds = registry
                ? normalizeTableGroupRegistry(registry).groups.map(group => group.id)
                : [];
            for (const tableGroupId of groupIds) {
                if (!isCurrent()) return;
                if (!isSecondaryAutomaticMode()) break;
                try {
                    // Re-read authority and tables after each Group; UI selection is not a target.
                    const context = getContext();
                    const liveRegistry = readTableGroupRegistryFromContext(context);
                    if (!liveRegistry
                        || !isTableGroupAutomaticFillEnabled(context, liveRegistry, tableGroupId)) continue;
                    const tables = getMemoryState();
                    if (!Array.isArray(tables)) continue;
                    const groupScope = createTableGroupFillScope(tables, liveRegistry, tableGroupId);
                    if (!groupScope.scopedState.some(isAiFillableTable)) continue;
                    await fillWithSecondaryApi(latestMessage, false, {
                        tableGroupId,
                        __secondaryExpectedScope: requestScope,
                    });
                } catch (error) {
                    console.error(`[Pipeline:TableUpdate] Automatic Group "${tableGroupId}" failed:`, error);
                }
                if (!isCurrent()) return;
            }
        } catch (error) {
            console.error('[Pipeline:TableUpdate] Automatic Group scheduling failed:', error);
        }
    }
    if (!isCurrent()) return;
    return next();
}
