import { loadWorldInfo, createNewWorldInfo, saveWorldInfo, world_names, createWorldInfoEntry } from "/scripts/world-info.js";
import { characters, eventSource, event_types } from "/script.js";
import { getContext } from "/scripts/extensions.js";


export function isTavernHelperAvailable() {
    return typeof window.TavernHelper !== 'undefined' && 
           window.TavernHelper !== null &&
           typeof window.TavernHelper.getLorebooks === 'function';
}


export async function safeLorebooks() {
    try {
        if (isTavernHelperAvailable()) {
            return await window.TavernHelper.getLorebooks();
        }
        return [...world_names];
    } catch (error) {
        console.error('[Amily2-兼容性] 获取世界书列表失败:', error);
        return [...world_names];
    }
}


export async function safeCharLorebooks(options = { type: 'all' }) {
    try {
        if (isTavernHelperAvailable()) {
            return await window.TavernHelper.getCharLorebooks(options);
        }
        const context = getContext();
        const character = characters[context.characterId];
        const primary = character?.data?.extensions?.world;
        return { primary: primary || null, additional: [] };
    } catch (error) {
        console.error('[Amily2-兼容性] 获取角色世界书失败:', error);
        const context = getContext();
        const character = characters[context.characterId];
        const primary = character?.data?.extensions?.world;
        return { primary: primary || null, additional: [] };
    }
}

export async function safeLorebookEntries(bookName) {
    try {
        if (isTavernHelperAvailable()) {
            return await window.TavernHelper.getLorebookEntries(bookName);
        }
        const bookData = await loadWorldInfo(bookName);
        if (!bookData || !bookData.entries) return [];
        return Object.entries(bookData.entries).map(([uid, entry]) => ({
            uid: parseInt(uid),
            comment: entry.comment || '无标题条目',
            content: entry.content || '',
            key: entry.key || [],
            enabled: !entry.disable,
            constant: entry.constant || false,
            position: entry.position || 4,
            depth: entry.depth || 998,
        }));
    } catch (error) {
        console.error(`[Amily2-兼容性] 获取世界书 ${bookName} 条目失败:`, error);
        return [];
    }
}


export async function safeUpdateLorebookEntries(bookName, entries) {
    try {
        if (isTavernHelperAvailable()) {
            await window.TavernHelper.setLorebookEntries(bookName, entries);
            return true;
        }

        const bookData = await loadWorldInfo(bookName);
        if (!bookData) return false;
        for (const entryUpdate of entries) {
            const existingEntry = bookData.entries[entryUpdate.uid];
            if (existingEntry) {
                if (entryUpdate.content !== undefined) existingEntry.content = entryUpdate.content;
                if (entryUpdate.enabled !== undefined) existingEntry.disable = !entryUpdate.enabled;
            }
        }
        await saveWorldInfo(bookName, bookData, true);
        return true;
    } catch (error) {
        console.error(`[Amily2-兼容性] 更新世界书条目失败:`, error);
        return false;
    }
}


export async function compatibleWriteToLorebook(targetLorebookName, entryComment, contentUpdateCallback, options = {}) {
    console.log('[Amily2-兼容性] compatibleWriteToLorebook 接收到的选项:', options);

    if (isTavernHelperAvailable()) {
        try {
            if (!world_names.includes(targetLorebookName)) {
                await createNewWorldInfo(targetLorebookName);
                if (Array.isArray(world_names) && !world_names.includes(targetLorebookName)) {
                    world_names.push(targetLorebookName);
                    world_names.sort();
                }
                if (eventSource && typeof eventSource.emit === "function" && event_types.CHARACTER_PAGE_LOADED) {
                    eventSource.emit(event_types.CHARACTER_PAGE_LOADED);
                }
                console.log(`[Amily2-兼容性] (混合模式) 已创建新世界书: ${targetLorebookName}`);
            }

            const entries = await safeLorebookEntries(targetLorebookName);
            const existingEntry = entries.find((e) => e.comment === entryComment && !e.disable);

            if (existingEntry) {
                const newContent = contentUpdateCallback(existingEntry.content);
                await safeUpdateLorebookEntries(targetLorebookName, [{ uid: existingEntry.uid, content: newContent }]);
            } else {
                const newContent = contentUpdateCallback(null);
                const { keys = [], isConstant = false, insertion_position, depth: insertion_depth } = options;
                const positionMap = { 'before_char': 0, 'after_char': 1, 'before_an': 2, 'after_an': 3, 'at_depth': 4 };
                
                const newEntryData = {
                    comment: entryComment, content: newContent, key: keys,
                    constant: isConstant, position: positionMap[insertion_position] ?? 4,
                    depth: parseInt(insertion_depth) || 998, enabled: true,
                };

                await window.TavernHelper.createLorebookEntries(targetLorebookName, [newEntryData]);
                
                const bookData = await loadWorldInfo(targetLorebookName);
                const createdEntry = Object.values(bookData.entries).find(e => e.comment === entryComment);
                if (createdEntry) {
                    createdEntry.constant = isConstant;
                    createdEntry.position = positionMap[insertion_position] ?? 4;
                    createdEntry.depth = parseInt(insertion_depth) || 998;
                    await saveWorldInfo(targetLorebookName, bookData, true);
                    console.log(`[Amily2-兼容性] (混合模式) 已修正条目激活状态、位置和深度。`);
                }
            }
            console.log(`[Amily2-兼容性] (混合模式) 成功写入条目 "${entryComment}"。`);
            return true;
        } catch (error) {
            console.error(`[Amily2-兼容性] (混合模式) 写入失败:`, error);
            toastr.error(`写入世界书失败: ${error.message}`, "Amily2号-兼容性模块");
            return false;
        }
    } else {
        console.warn('[Amily2-兼容性] TavernHelper 不可用，回退到传统写入逻辑。');
        try {
            if (!world_names.includes(targetLorebookName)) {
                await createNewWorldInfo(targetLorebookName);
                console.log(`[Amily2-兼容性] (传统模式) 已创建新世界书: ${targetLorebookName}`);
            }

            const bookData = await loadWorldInfo(targetLorebookName);
            if (!bookData) throw new Error(`无法加载世界书《${targetLorebookName}》`);

            const existingEntry = Object.values(bookData.entries).find(e => e.comment === entryComment && !e.disable);

            if (existingEntry) {
                existingEntry.content = contentUpdateCallback(existingEntry.content);
            } else {
                const newContent = contentUpdateCallback(null);
                const { keys = [], isConstant = false, insertion_position, depth: insertion_depth } = options;
                const positionMap = { 'before_char': 0, 'after_char': 1, 'before_an': 2, 'after_an': 3, 'at_depth': 4 };
                
                const newEntry = createWorldInfoEntry(targetLorebookName, bookData);
                Object.assign(newEntry, {
                    comment: entryComment, content: newContent, key: keys,
                    constant: isConstant, position: positionMap[insertion_position] ?? 4,
                    depth: parseInt(insertion_depth) || 998, disable: false,
                });
            }

            await saveWorldInfo(targetLorebookName, bookData, true);
            console.log(`[Amily2-兼容性] (传统模式) 成功写入条目 "${entryComment}"。`);
            return true;
        } catch (error) {
            console.error(`[Amily2-兼容性] (传统模式) 写入失败:`, error);
            toastr.error(`传统模式写入世界书失败: ${error.message}`, "Amily2号-兼容性模块");
            return false;
        }
    }
}


export async function safeTriggerSlash(command) {
    if (isTavernHelperAvailable() && typeof window.TavernHelper.triggerSlash === 'function') {
        try {
            return await window.TavernHelper.triggerSlash(command);
        } catch (error) {
            console.error(`[Amily2-兼容性] TavernHelper.triggerSlash 执行失败:`, error);
            throw error;
        }
    } else {
        const errorMsg = 'TavernHelper 或 triggerSlash 方法不可用';
        console.error(`[Amily2-兼容性] ${errorMsg}`);
        throw new Error(errorMsg);
    }
}
