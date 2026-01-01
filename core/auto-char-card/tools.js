import { amilyHelper } from "../tavern-helper/main.js";
import * as charApi from "./char-api.js";
import { callAi } from "./api.js";

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
                comment: e.comment || keys || "未命名条目",
            };
        });
        
        return JSON.stringify({
            info: "世界书条目索引。请使用带有 'uid' 的 'read_world_entry' 来读取具体内容。",
            total_entries: entries.length,
            entries: summary
        }, null, 2);
    },

    read_world_entry: async ({ book_name, uid }) => {
        const entries = await amilyHelper.getLorebookEntries(book_name);
        const entry = entries.find(e => String(e.uid) === String(uid));
        
        if (!entry) {
            return JSON.stringify({
                status: "error",
                code: "ENTRY_NOT_FOUND",
                message: `在世界书 "${book_name}" 中未找到 UID 为 ${uid} 的条目。`,
                suggestion: "请使用 'read_world_info' 查看可用的 UID。"
            });
        }
        
        return JSON.stringify({
            status: "success",
            data: entry
        }, null, 2);
    },

    write_world_info_entry: async ({ book_name, entries }) => {
        if (typeof entries === 'string') {
            try {
                const cleanEntries = entries.replace(/```json/g, '').replace(/```/g, '').trim();
                entries = JSON.parse(cleanEntries);
            } catch (e) {
                return JSON.stringify({
                    status: "error",
                    code: "INVALID_JSON",
                    message: `'entries' 参数必须是有效的 JSON 数组。解析错误: ${e.message}`
                });
            }
        }
        if (!Array.isArray(entries)) {
            if (typeof entries === 'object' && entries !== null) {
                entries = [entries];
            } else {
                return JSON.stringify({
                    status: "error",
                    code: "INVALID_TYPE",
                    message: "'entries' 参数必须是数组或对象。"
                });
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

        let updatedCount = 0;
        let createdCount = 0;
        let errors = [];

        if (updates.length > 0) {
            const success = await amilyHelper.setLorebookEntries(book_name, updates);
            if (success) updatedCount = updates.length;
            else errors.push("更新条目失败。");
        }
        if (creates.length > 0) {
            const success = await amilyHelper.createLorebookEntries(book_name, creates);
            if (success) createdCount = creates.length;
            else errors.push("创建条目失败。");
        }

        if (errors.length > 0 && updatedCount === 0 && createdCount === 0) {
            return JSON.stringify({
                status: "error",
                code: "WRITE_FAILED",
                message: errors.join(" ")
            });
        }

        return JSON.stringify({
            status: "success",
            message: `成功更新了 ${updatedCount} 个条目，创建了 ${createdCount} 个条目。`,
            data: { updated: updatedCount, created: createdCount }
        });
    },

    create_world_book: async ({ book_name }) => {
        const success = await amilyHelper.createLorebook(book_name);
        if (success) {
            return JSON.stringify({
                status: "success",
                message: `世界书 "${book_name}" 创建成功。`
            });
        } else {
            return JSON.stringify({
                status: "error",
                code: "CREATE_FAILED",
                message: `创建世界书 "${book_name}" 失败。`
            });
        }
    },

    read_character_card: async ({ chid }) => {
        const char = charApi.getCharacter(chid);
        if (!char) {
            return JSON.stringify({
                status: "error",
                code: "CHAR_NOT_FOUND",
                message: "未找到角色。"
            });
        }
        
        const safeChar = {
            name: char.name,
            description: char.description,
            personality: char.personality,
            scenario: char.scenario,
            first_mes: char.first_mes,
            mes_example: char.mes_example,
            alternate_greetings: char.data?.alternate_greetings || []
        };
        return JSON.stringify({
            status: "success",
            data: safeChar
        }, null, 2);
    },

    update_character_card: async (args) => {
        const { chid, ...updates } = args;
        const finalUpdates = args.updates || updates;
        
        const success = charApi.updateCharacter(chid, finalUpdates);
        if (success) {
            const updatedFields = Object.keys(finalUpdates).join(', ');
            return JSON.stringify({
                status: "success",
                message: `角色卡更新成功 [ID: ${chid}]。`,
                data: { updated_fields: updatedFields }
            });
        } else {
            return JSON.stringify({
                status: "error",
                code: "UPDATE_FAILED",
                message: "更新角色卡失败。"
            });
        }
    },

    edit_character_text: async ({ chid, field, diff }) => {
        const char = charApi.getCharacter(chid);
        if (!char) {
            return JSON.stringify({
                status: "error",
                code: "CHAR_NOT_FOUND",
                message: "未找到角色。"
            });
        }

        const allowedFields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example'];
        if (!allowedFields.includes(field)) {
            return JSON.stringify({
                status: "error",
                code: "INVALID_FIELD",
                message: `无效的字段。允许的字段: ${allowedFields.join(', ')}`
            });
        }

        let content = char[field] || '';
        const changes = diff.split('------- SEARCH');

        if (changes[0].trim() === '') changes.shift();

        for (const change of changes) {
            const parts = change.split('=======');
            if (parts.length !== 2) continue;

            const searchBlock = parts[0].trim();
            const replaceBlock = parts[1].split('+++++++ REPLACE')[0].trim();

            if (!content.includes(searchBlock)) {
                return JSON.stringify({
                    status: "error",
                    code: "SEARCH_NOT_FOUND",
                    message: `在字段 '${field}' 中未找到搜索块。`,
                    suggestion: "请确保 SEARCH 块与现有内容完全匹配（包括空格）。"
                });
            }

            content = content.replace(searchBlock, replaceBlock);
        }

        const success = charApi.updateCharacter(chid, { [field]: content });
        if (success) {
            return JSON.stringify({
                status: "success",
                message: `字段 '${field}' 更新成功。`
            });
        } else {
            return JSON.stringify({
                status: "error",
                code: "UPDATE_FAILED",
                message: `更新字段 '${field}' 失败。`
            });
        }
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
                return JSON.stringify({
                    status: "error",
                    code: "INVALID_ACTION",
                    message: "无效的操作。"
                });
        }
        
        if (success) {
            return JSON.stringify({
                status: "success",
                message: `开场白 ${action} 成功。`
            });
        } else {
            return JSON.stringify({
                status: "error",
                code: "ACTION_FAILED",
                message: `开场白 ${action} 失败。`
            });
        }
    },

    create_character: async ({ name }) => {
        const result = await charApi.createNewCharacter(name);
        if (result === -1) {
            return JSON.stringify({
                status: "error",
                code: "CREATE_FAILED",
                message: "创建角色失败。"
            });
        }
        if (result === -2) {
            return JSON.stringify({
                status: "warning",
                code: "CREATE_PENDING",
                message: "角色创建请求已发送。请手动刷新。"
            });
        }
        return JSON.stringify({
            status: "success",
            message: `角色创建成功。`,
            data: { id: result }
        });
    },

    simulate_chat: async ({ chid, message }) => {
        const char = charApi.getCharacter(chid);
        if (!char) {
            return JSON.stringify({
                status: "error",
                code: "CHAR_NOT_FOUND",
                message: "未找到角色。"
            });
        }

        const systemPrompt = `You are roleplaying as ${char.name}.
Description: ${char.description}
Personality: ${char.personality}
Scenario: ${char.scenario}

Reply to the user's message in character. Stay in character.`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message }
        ];

        try {
            const response = await callAi('executor', messages, { temperature: 0.9 });
            return JSON.stringify({
                status: "success",
                data: { 
                    character: char.name,
                    response: response 
                }
            });
        } catch (error) {
            return JSON.stringify({
                status: "error",
                code: "SIMULATION_FAILED",
                message: `模拟对话失败: ${error.message}`
            });
        }
    },

    set_style_reference: async ({ style }) => {

        return JSON.stringify({
            status: "success",
            message: `样式参考已设置为: ${style}`,
            _action: "update_task_state",
            _updates: { style_reference: style }
        });
    },

    analyze_entities: async ({ text }) => {
        const systemPrompt = `You are an expert World Builder and Entity Extractor.
Analyze the provided text and identify key entities that should have their own World Info (Lorebook) entries.
Focus on:
- Proper Nouns (People, Places, Organizations, Artifacts)
- Unique Concepts (Magic systems, Historical events, Species)

Return a JSON object with a "entities" array. Each entity should have:
- "name": The name of the entity.
- "type": The type (Person, Location, Organization, etc.).
- "description": A brief summary based on the text (1-2 sentences).
- "confidence": A score (0-1) of how important this entity seems.

Output ONLY valid JSON.`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
        ];

        try {
            const response = await callAi('executor', messages, { temperature: 0.1 }); 
            const cleanResponse = response.replace(/```json/g, '').replace(/```/g, '').trim();
            return cleanResponse;
        } catch (error) {
            return JSON.stringify({
                status: "error",
                code: "ANALYSIS_FAILED",
                message: `实体分析失败: ${error.message}`
            });
        }
    },

    ask_user: async ({ question }) => {
        return JSON.stringify({
            status: "success",
            message: `已向用户提问: ${question}`,
            _action: "stop_and_wait",
            data: { question }
        });
    }
};

export function getToolDefinitions() {
    return [
        {
            name: "read_world_info",
            description: "读取世界书的索引（包含关键字和注释的条目列表）。不返回完整内容。",
            parameters: {
                type: "object",
                properties: {
                    book_name: { type: "string", description: "世界书名称。" }
                },
                required: ["book_name"]
            }
        },
        {
            name: "read_world_entry",
            description: "读取特定世界书条目的完整内容。",
            parameters: {
                type: "object",
                properties: {
                    book_name: { type: "string", description: "世界书名称。" },
                    uid: { type: "number", description: "要读取的条目 UID。" }
                },
                required: ["book_name", "uid"]
            }
        },
        {
            name: "write_world_info_entry",
            description: "创建或更新世界书中的条目。",
            parameters: {
                type: "object",
                properties: {
                    book_name: { type: "string", description: "世界书名称。" },
                    entries: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                uid: { type: "number", description: "条目 ID（可选，用于更新）。" },
                                comment: { type: "string", description: "条目标题/注释。" },
                                content: { type: "string", description: "条目内容。" },
                                key: { type: "array", items: { type: "string" }, description: "关键字。" },
                                enabled: { type: "boolean", description: "是否启用。" },
                                constant: { type: "boolean", description: "常驻（蓝灯）。" },
                                position: { type: "string", enum: ["before_character_definition", "after_character_definition", "before_author_note", "after_author_note", "at_depth_as_system"], description: "插入位置。" },
                                depth: { type: "number", description: "插入深度。" },
                                scanDepth: { type: "number", description: "扫描深度。" },
                                exclude_recursion: { type: "boolean", description: "排除递归。" },
                                prevent_recursion: { type: "boolean", description: "防止递归。" }
                            }
                        }
                    }
                },
                required: ["book_name", "entries"]
            }
        },
        {
            name: "create_world_book",
            description: "创建一个新的空世界书。",
            parameters: {
                type: "object",
                properties: {
                    book_name: { type: "string", description: "新世界书的名称。" }
                },
                required: ["book_name"]
            }
        },
        {
            name: "read_character_card",
            description: "读取角色卡数据。",
            parameters: {
                type: "object",
                properties: {
                    chid: { type: "number", description: "角色 ID。" }
                },
                required: ["chid"]
            }
        },
        {
            name: "update_character_card",
            description: "更新角色卡字段（覆盖）。",
            parameters: {
                type: "object",
                properties: {
                    chid: { type: "number", description: "角色 ID。" },
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
            description: "使用 搜索/替换 块编辑角色的特定文本字段。",
            parameters: {
                type: "object",
                properties: {
                    chid: { type: "number", description: "角色 ID。" },
                    field: { type: "string", enum: ["description", "personality", "scenario", "first_mes", "mes_example"], description: "要编辑的字段。" },
                    diff: { 
                        type: "string", 
                        description: "一个或多个遵循此确切格式的 搜索/替换 块:\n------- SEARCH\n[exact content to find]\n=======\n[new content to replace with]\n+++++++ REPLACE" 
                    }
                },
                required: ["chid", "field", "diff"]
            }
        },
        {
            name: "manage_first_message",
            description: "添加、更新或删除候补开场白。",
            parameters: {
                type: "object",
                properties: {
                    action: { type: "string", enum: ["add", "update", "remove"] },
                    chid: { type: "number", description: "角色 ID。" },
                    index: { type: "number", description: "开场白索引（更新/删除时必需）。" },
                    message: { type: "string", description: "开场白内容（添加/更新时必需）。" }
                },
                required: ["action", "chid"]
            }
        },
        {
            name: "create_character",
            description: "创建一个新角色卡。",
            parameters: {
                type: "object",
                properties: {
                    name: { type: "string", description: "新角色的名字。" }
                },
                required: ["name"]
            }
        },
        {
            name: "simulate_chat",
            description: "与角色模拟对话以测试其性格和设定。",
            parameters: {
                type: "object",
                properties: {
                    chid: { type: "number", description: "角色 ID。" },
                    message: { type: "string", description: "发送给角色的消息。" }
                },
                required: ["chid", "message"]
            }
        },
        {
            name: "set_style_reference",
            description: "设置生成内容的风格参考或模板（例如：'黑暗奇幻风格'，'莎士比亚风格'，'JSON格式模板'）。",
            parameters: {
                type: "object",
                properties: {
                    style: { type: "string", description: "风格描述或模板内容。" }
                },
                required: ["style"]
            }
        },
        {
            name: "analyze_entities",
            description: "分析文本并提取潜在的世界书条目（实体）。",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "要分析的文本。" }
                },
                required: ["text"]
            }
        },
        {
            name: "ask_user",
            description: "向用户提问以获取更多信息或确认。这将暂停自动执行并等待用户回复。",
            parameters: {
                type: "object",
                properties: {
                    question: { type: "string", description: "要问的问题。" }
                },
                required: ["question"]
            }
        }
    ];
}
