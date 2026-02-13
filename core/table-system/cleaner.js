import { getContext, extension_settings } from '/scripts/extensions.js';
import { saveChatDebounced } from '/script.js';
import { log } from './logger.js';
import { extensionName } from '../../utils/settings.js';

const TABLE_DATA_KEY = 'amily2_tables_data';

export async function clearTableRecordsBefore(floorIndex) {
    const context = getContext();
    if (!context || !context.chat || context.chat.length === 0) {
        log('无法清除：聊天记录为空。', 'warn');
        return 0;
    }

    let clearedCount = 0;
    const chat = context.chat;
    const targetIndex = Math.min(floorIndex, chat.length);

    log(`开始清除第 ${targetIndex} 楼之前的表格记录...`, 'info');

    for (let i = 0; i < targetIndex; i++) {
        const message = chat[i];
        if (message.extra && message.extra[TABLE_DATA_KEY]) {
            delete message.extra[TABLE_DATA_KEY];
            if (Object.keys(message.extra).length === 0) {
                delete message.extra;
            }
            clearedCount++;
        }
    }

    if (clearedCount > 0) {
        await saveChatDebounced();
        log(`成功清除了 ${clearedCount} 条消息中的表格记录。`, 'success');
    } else {
        log('没有发现需要清除的表格记录。', 'info');
    }

    return clearedCount;
}
