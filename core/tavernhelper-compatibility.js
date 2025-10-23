import { amilyHelper } from './tavern-helper/main.js';
import { eventSource, event_types } from "/script.js";

// 我们现在总是“可用”的，因为我们依赖自己的实现，而不是那个屎山酒馆。
export function isTavernHelperAvailable() {
    return true;
}
export async function compatibleTriggerSlash(command) {
    return await amilyHelper.triggerSlash(command);
}

export async function safeLorebooks() {
    return amilyHelper.getLorebooks();
}

export async function safeCharLorebooks(options = { type: 'all' }) {
    return amilyHelper.getCharLorebooks(options);
}

export async function safeLorebookEntries(bookName) {
    return amilyHelper.getLorebookEntries(bookName);
}

export async function safeUpdateLorebookEntries(bookName, entries) {
    return amilyHelper.setLorebookEntries(bookName, entries);
}


export async function compatibleWriteToLorebook(targetLorebookName, entryComment, contentUpdateCallback, options = {}) {
    console.log('[Amily助手-写入模块] 接收到的写入选项:', options);

    try {
        const entries = await amilyHelper.getLorebookEntries(targetLorebookName);
        const existingEntry = entries.find((e) => e.comment === entryComment && e.enabled);

        if (existingEntry) {
            const newContent = contentUpdateCallback(existingEntry.content);
            await amilyHelper.setLorebookEntries(targetLorebookName, [{ uid: existingEntry.uid, content: newContent }]);
        } else {
            const newContent = contentUpdateCallback(null);
            const { keys = [], isConstant = false, insertion_position, depth: insertion_depth } = options;
            
            const positionMap = { 'before_char': 0, 'after_char': 1, 'before_an': 2, 'after_an': 3, 'at_depth': 4 };
            
            const newEntryData = {
                comment: entryComment,
                content: newContent,
                key: keys,
                constant: isConstant,
                position: positionMap[insertion_position] ?? 4,
                depth: parseInt(insertion_depth) || 998,
                enabled: true,
            };

            await amilyHelper.createLorebookEntries(targetLorebookName, [newEntryData]);
        }

        if (eventSource && typeof eventSource.emit === "function" && event_types.CHARACTER_PAGE_LOADED) {
            eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
        }

        console.log(`[Amily助手] 成功将条目 "${entryComment}" 写入《${targetLorebookName}》。`);
        return true;
    } catch (error) {
        console.error(`[Amily助手] 写入世界书时发生严重错误:`, error);
        toastr.error(`写入世界书失败: ${error.message}`, "Amily助手");
        return false;
    }
}
