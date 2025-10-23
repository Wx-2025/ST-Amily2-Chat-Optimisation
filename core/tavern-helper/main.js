import { 
    world_names, 
    loadWorldInfo, 
    saveWorldInfo, 
    createNewWorldInfo, 
    createWorldInfoEntry 
} from "/scripts/world-info.js";
import { characters } from "/script.js";
import { getContext } from "/scripts/extensions.js";
import { executeSlashCommandsWithOptions } from '/scripts/slash-commands.js';


class AmilyHelper {

    async getLorebooks() {
        return [...world_names];
    }

    async getCharLorebooks(options = { type: 'all' }) {
        try {
            const context = getContext();
            if (!context || !context.characterId) {
                console.warn('[Amily助手] 无法获取当前角色上下文。');
                return { primary: null, additional: [] };
            }
            const character = characters[context.characterId];
            const primary = character?.data?.extensions?.world;
            return { primary: primary || null, additional: [] };
        } catch (error) {
            console.error('[Amily助手] 获取角色世界书时出错:', error);
            return { primary: null, additional: [] };
        }
    }

    async getLorebookEntries(bookName) {
        try {
            const bookData = await loadWorldInfo(bookName);
            if (!bookData || !bookData.entries) {
                return [];
            }
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
            console.error(`[Amily助手] 获取世界书《${bookName}》条目时出错:`, error);
            return [];
        }
    }

    async setLorebookEntries(bookName, entries) {
        try {
            const bookData = await loadWorldInfo(bookName);
            if (!bookData) {
                console.error(`[Amily助手] 更新失败：找不到世界书《${bookName}》。`);
                return false;
            }
            for (const entryUpdate of entries) {
                const existingEntry = bookData.entries[entryUpdate.uid];
                if (existingEntry) {
                    if (entryUpdate.content !== undefined) existingEntry.content = entryUpdate.content;
                    if (entryUpdate.enabled !== undefined) existingEntry.disable = !entryUpdate.enabled;
                    if (entryUpdate.comment !== undefined) existingEntry.comment = entryUpdate.comment;
                    if (entryUpdate.key !== undefined) existingEntry.key = entryUpdate.key;
                    if (entryUpdate.constant !== undefined) existingEntry.constant = entryUpdate.constant;
                    if (entryUpdate.position !== undefined) existingEntry.position = entryUpdate.position;
                    if (entryUpdate.depth !== undefined) existingEntry.depth = entryUpdate.depth;
                }
            }
            await saveWorldInfo(bookName, bookData, true);
            return true;
        } catch (error) {
            console.error(`[Amily助手] 更新世界书《${bookName}》条目时出错:`, error);
            return false;
        }
    }

    async createLorebookEntries(bookName, entries) {
        try {
            let bookData = await loadWorldInfo(bookName);
            if (!bookData) {
                console.warn(`[Amily助手] 世界书《${bookName}》不存在，将自动创建。`);
                await this.createLorebook(bookName);
                bookData = await loadWorldInfo(bookName);
                if (!bookData) {
                    throw new Error(`创建并加载世界书《${bookName}》失败。`);
                }
            }

            for (const newEntryData of entries) {
                const newEntry = createWorldInfoEntry(bookName, bookData);
                Object.assign(newEntry, {
                    comment: newEntryData.comment || '新条目',
                    content: newEntryData.content || '',
                    key: newEntryData.key || [],
                    constant: newEntryData.constant || false,
                    position: newEntryData.position ?? 4,
                    depth: newEntryData.depth ?? 998,
                    disable: !(newEntryData.enabled ?? true),
                });
            }
            await saveWorldInfo(bookName, bookData, true);
            return true;
        } catch (error) {
            console.error(`[Amily助手] 在世界书《${bookName}》中创建新条目时出错:`, error);
            return false;
        }
    }

    async createLorebook(bookName) {
        try {
            if (world_names.includes(bookName)) {
                console.warn(`[Amily助手] 创建失败：世界书《${bookName}》已存在。`);
                return false;
            }
            await createNewWorldInfo(bookName);
            if (!world_names.includes(bookName)) {
                world_names.push(bookName);
                world_names.sort();
            }
            return true;
        } catch (error) {
            console.error(`[Amily助手] 创建世界书《${bookName}》时出错:`, error);
            return false;
        }
    }

    async triggerSlash(command) {
        try {
            console.log(`[Amily助手] 正在执行斜杠命令: ${command}`);
            const result = await executeSlashCommandsWithOptions(command);
            if (result.isError) {
                throw new Error(result.errorMessage);
            }
            return result.pipe;
        } catch (error) {
            console.error(`[Amily助手] 执行斜杠命令 '${command}' 时出错:`, error);
            throw error;
        }
    }
}

export const amilyHelper = new AmilyHelper();
