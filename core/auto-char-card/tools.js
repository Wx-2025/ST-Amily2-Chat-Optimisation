import { amilyHelper } from "../tavern-helper/main.js";
import * as charApi from "./char-api.js";

export const tools = {
    
    read_world_info: async ({ book_name, return_full = false }) => {
        const entries = await amilyHelper.getLorebookEntries(book_name);
        
        if (return_full) {
            return JSON.stringify(entries, null, 2);
        }

        const summary = entries.map(e => {
            let keys = e.key;
            if (Array.isArray(keys)) keys = keys.join(', ');
            
            return {
                uid: e.uid,
                keys: keys,
                comment: e.comment || keys || "Unnamed Entry",
            };
        });
        
        return JSON.stringify({
            info: "Index of world book entries. Use 'read_world_entry' with 'uid' to read specific content.",
            total_entries: entries.length,
            entries: summary
        }, null, 2);
    },

    read_world_entry: async ({ book_name, uid }) => {
        const entries = await amilyHelper.getLorebookEntries(book_name);
        const entry = entries.find(e => String(e.uid) === String(uid));
        
        if (!entry) {
            return `Entry with UID ${uid} not found in world book "${book_name}".`;
        }
        
        return JSON.stringify(entry, null, 2);
    },

    write_world_info_entry: async ({ book_name, entries }) => {
        if (typeof entries === 'string') {
            try {
                const cleanEntries = entries.replace(/```json/g, '').replace(/```/g, '').trim();
                entries = JSON.parse(cleanEntries);
            } catch (e) {
                return `错误: 'entries' 参数必须是有效的 JSON 数组。解析错误: ${e.message}`;
            }
        }
        if (!Array.isArray(entries)) {
            if (typeof entries === 'object' && entries !== null) {
                entries = [entries];
            } else {
                return "错误: 'entries' 参数必须是数组或对象。";
            }
        }

        const updates = [];
        const creates = [];

        for (const entry of entries) {
            if (entry.uid !== undefined) {
                updates.push(entry);
            } else {
                creates.push(entry);
            }
        }

        let resultMsg = "";
        if (updates.length > 0) {
            const success = await amilyHelper.setLorebookEntries(book_name, updates);
            resultMsg += success ? `成功更新了 ${updates.length} 个条目。 ` : `更新条目失败。 `;
        }
        if (creates.length > 0) {
            const success = await amilyHelper.createLorebookEntries(book_name, creates);
            resultMsg += success ? `成功创建了 ${creates.length} 个条目。 ` : `创建条目失败。 `;
        }
        return resultMsg || "未执行任何操作。";
    },

    create_world_book: async ({ book_name }) => {
        const success = await amilyHelper.createLorebook(book_name);
        return success ? `世界书 "${book_name}" 创建成功。` : `创建世界书 "${book_name}" 失败。`;
    },

    read_character_card: async ({ chid }) => {
        const char = charApi.getCharacter(chid);
        if (!char) return "未找到角色。";
        
        const safeChar = {
            name: char.name,
            description: char.description,
            personality: char.personality,
            scenario: char.scenario,
            first_mes: char.first_mes,
            mes_example: char.mes_example,
            alternate_greetings: char.data?.alternate_greetings || []
        };
        return JSON.stringify(safeChar, null, 2);
    },

    update_character_card: async (args) => {
        const { chid, ...updates } = args;
        const finalUpdates = args.updates || updates;
        
        const success = charApi.updateCharacter(chid, finalUpdates);
        if (success) {
            const updatedFields = Object.keys(finalUpdates).join(', ');
            return `角色卡更新成功 [ID: ${chid}]。已更新字段: ${updatedFields}。`;
        } else {
            return "更新角色卡失败。";
        }
    },

    edit_character_text: async ({ chid, field, diff }) => {
        const char = charApi.getCharacter(chid);
        if (!char) return "未找到角色。";

        const allowedFields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
        if (!allowedFields.includes(field)) {
            return `无效的字段。允许的字段: ${allowedFields.join(', ')}`;
        }

        let content = char[field] || '';
        const changes = diff.split('------- SEARCH');
        
        // Remove the first empty split if any
        if (changes[0].trim() === '') changes.shift();

        for (const change of changes) {
            const parts = change.split('=======');
            if (parts.length !== 2) continue;

            const searchBlock = parts[0].trim();
            const replaceBlock = parts[1].split('+++++++ REPLACE')[0].trim();

            if (!content.includes(searchBlock)) {
                return `错误: 在字段 '${field}' 中未找到以下搜索块:\n${searchBlock}`;
            }

            content = content.replace(searchBlock, replaceBlock);
        }

        const success = charApi.updateCharacter(chid, { [field]: content });
        return success ? `字段 '${field}' 更新成功。` : `更新字段 '${field}' 失败。`;
    },

    manage_first_message: async ({ action, chid, index, message }) => {
        let success = false;
        switch (action) {
            case 'add':
                success = charApi.addFirstMessage(chid, message);
                break;
            case 'update':
                success = charApi.updateFirstMessage(chid, index, message);
                break;
            case 'remove':
                success = charApi.removeFirstMessage(chid, index);
                break;
            default:
                return "无效的操作。";
        }
        return success ? `开场白 ${action} 成功。` : `开场白 ${action} 失败。`;
    },

    create_character: async ({ name }) => {
        const result = await charApi.createNewCharacter(name);
        if (result === -1) return "创建角色失败。";
        if (result === -2) return "角色创建请求已发送。请手动刷新角色列表以查看新角色。";
        return `角色创建成功，ID: ${result}`;
    }
};

export function getToolDefinitions() {
    return [
        {
            name: "read_world_info",
            description: "Read the index (list of entries with keys and comments) of a world book. Does NOT return full content.",
            parameters: {
                type: "object",
                properties: {
                    book_name: { type: "string", description: "The name of the world book." }
                },
                required: ["book_name"]
            }
        },
        {
            name: "read_world_entry",
            description: "Read the full content of a specific world book entry.",
            parameters: {
                type: "object",
                properties: {
                    book_name: { type: "string", description: "The name of the world book." },
                    uid: { type: "number", description: "The UID of the entry to read." }
                },
                required: ["book_name", "uid"]
            }
        },
        {
            name: "write_world_info_entry",
            description: "Create or update entries in a world book.",
            parameters: {
                type: "object",
                properties: {
                    book_name: { type: "string", description: "The name of the world book." },
                    entries: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                uid: { type: "number", description: "Entry ID (optional, for update)." },
                                comment: { type: "string", description: "Entry title/comment." },
                                content: { type: "string", description: "Entry content." },
                                key: { type: "array", items: { type: "string" }, description: "Keywords." },
                                enabled: { type: "boolean", description: "Is enabled." },
                                constant: { type: "boolean", description: "Constant (Blue light)." },
                                position: { type: "string", enum: ["before_character_definition", "after_character_definition", "before_author_note", "after_author_note", "at_depth_as_system"], description: "Insertion position." },
                                depth: { type: "number", description: "Insertion depth." },
                                scanDepth: { type: "number", description: "Scan depth." },
                                exclude_recursion: { type: "boolean", description: "Exclude from recursion." },
                                prevent_recursion: { type: "boolean", description: "Prevent recursion." }
                            }
                        }
                    }
                },
                required: ["book_name", "entries"]
            }
        },
        {
            name: "create_world_book",
            description: "Create a new empty world book.",
            parameters: {
                type: "object",
                properties: {
                    book_name: { type: "string", description: "The name of the new world book." }
                },
                required: ["book_name"]
            }
        },
        {
            name: "read_character_card",
            description: "Read character card data.",
            parameters: {
                type: "object",
                properties: {
                    chid: { type: "number", description: "Character ID." }
                },
                required: ["chid"]
            }
        },
        {
            name: "update_character_card",
            description: "Update character card fields (overwrite).",
            parameters: {
                type: "object",
                properties: {
                    chid: { type: "number", description: "Character ID." },
                    name: { type: "string" },
                    description: { type: "string" },
                    personality: { type: "string" },
                    scenario: { type: "string" },
                    first_mes: { type: "string" },
                    mes_example: { type: "string" }
                },
                required: ["chid"]
            }
        },
        {
            name: "edit_character_text",
            description: "Edit a specific text field of a character using SEARCH/REPLACE blocks.",
            parameters: {
                type: "object",
                properties: {
                    chid: { type: "number", description: "Character ID." },
                    field: { type: "string", enum: ["description", "personality", "scenario", "first_mes", "mes_example"], description: "The field to edit." },
                    diff: { 
                        type: "string", 
                        description: "One or more SEARCH/REPLACE blocks following this exact format:\n------- SEARCH\n[exact content to find]\n=======\n[new content to replace with]\n+++++++ REPLACE" 
                    }
                },
                required: ["chid", "field", "diff"]
            }
        },
        {
            name: "manage_first_message",
            description: "Add, update, or remove alternate greetings.",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["add", "update", "remove"] },
                    chid: { type: "number", description: "Character ID." },
                    index: { type: "number", description: "Index of the greeting (required for update/remove)." },
                    message: { type: "string", description: "Content of the greeting (required for add/update)." }
                },
                required: ["action", "chid"]
            }
        },
        {
            name: "create_character",
            description: "Create a new character card.",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "Name of the new character." }
                },
                required: ["name"]
            }
        }
    ];
}
