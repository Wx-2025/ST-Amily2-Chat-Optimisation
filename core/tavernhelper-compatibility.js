import { amilyHelper } from './tavern-helper/main.js';
import { 
    world_names,
    loadWorldInfo,
    createNewWorldInfo,
    createWorldInfoEntry,
    saveWorldInfo,
    reloadEditor
} from "/scripts/world-info.js";
import { refreshWorldbookListOnly } from './lore.js';

// 检查我们自己的 amilyHelper 是否存在
export function isTavernHelperAvailable() {
    return typeof amilyHelper !== 'undefined' && amilyHelper !== null;
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
    console.log('[兼容写入模块] 接收到的写入选项:', options);

    // 优先使用 AmilyHelper
    if (isTavernHelperAvailable()) {
        try {
            console.log('[兼容写入模块] 检测到 AmilyHelper，优先使用新逻辑...');
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
            console.log(`[Amily助手] 成功将条目 "${entryComment}" 写入《${targetLorebookName}》。`);
            
            // 派发被证明有效的自定义刷新事件
            document.dispatchEvent(new CustomEvent('amily-lorebook-created', { detail: { bookName: targetLorebookName } }));
            refreshWorldbookListOnly(); // 刷新UI
            return true;
        } catch (error) {
            console.error(`[Amily助手] 写入失败，将尝试回退到传统逻辑。错误:`, error);
            toastr.warning('Amily助手写入失败，尝试使用传统方式...', '兼容模式');
        }
    }

    // AmilyHelper 不可用或失败时的后备传统逻辑
    try {
        console.log('[兼容写入模块] AmilyHelper 不可用或失败，使用传统逻辑...');
        let bookData = await loadWorldInfo(targetLorebookName);

        if (!bookData) {
            console.warn(`[传统逻辑] 世界书《${targetLorebookName}》不存在，将自动创建。`);
            await createNewWorldInfo(targetLorebookName);
            if (!world_names.includes(targetLorebookName)) {
                world_names.push(targetLorebookName);
                world_names.sort();
                refreshWorldbookListOnly(); // 刷新UI
            }
            document.dispatchEvent(new CustomEvent('amily-lorebook-created', { detail: { bookName: targetLorebookName } }));
            bookData = await loadWorldInfo(targetLorebookName);
            if (!bookData) throw new Error(`创建并加载世界书《${targetLorebookName}》失败。`);
        }

        const existingEntry = Object.values(bookData.entries).find(e => e.comment === entryComment && !e.disable);

        if (existingEntry) {
            existingEntry.content = contentUpdateCallback(existingEntry.content);
        } else {
            const newEntry = createWorldInfoEntry(targetLorebookName, bookData);
            const { keys = [], isConstant = false, insertion_position, depth: insertion_depth } = options;
            const positionMap = { 'before_char': 0, 'after_char': 1, 'before_an': 2, 'after_an': 3, 'at_depth': 4 };

            Object.assign(newEntry, {
                comment: entryComment,
                content: contentUpdateCallback(null),
                key: keys,
                constant: isConstant,
                position: positionMap[insertion_position] ?? 4,
                depth: parseInt(insertion_depth) || 998,
                disable: false,
            });
        }

        await saveWorldInfo(targetLorebookName, bookData, true);
        console.log(`[传统逻辑] 成功将条目 "${entryComment}" 写入《${targetLorebookName}》。`);

        // 刷新编辑器（如果正在查看）
        reloadEditor(targetLorebookName);

        // 派发被证明有效的自定义刷新事件
        document.dispatchEvent(new CustomEvent('amily-lorebook-created', { detail: { bookName: targetLorebookName } }));
        return true;
    } catch (error) {
        console.error(`[传统逻辑] 写入世界书时发生严重错误:`, error);
        toastr.error(`写入世界书失败: ${error.message}`, "传统逻辑");
        return false;
    }
}
