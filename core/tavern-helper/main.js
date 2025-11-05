import { 
    world_names, 
    loadWorldInfo, 
    saveWorldInfo, 
    createNewWorldInfo, 
    createWorldInfoEntry,
    reloadEditor
} from "/scripts/world-info.js";
import { 
    characters, 
    eventSource, 
    event_types,
    chat,
    reloadCurrentChat,
    saveChatConditional,
    name1,
    name2,
    addOneMessage,
    messageFormatting,
    substituteParamsExtended
} from "/script.js";
import { getContext } from "/scripts/extensions.js";
import { executeSlashCommandsWithOptions } from '/scripts/slash-commands.js';


class AmilyHelper {

    // ==================== Chat Message 相关方法 ====================

    getChatMessages(range, options = {}) {
        const { role = 'all', hide_state = 'all', include_swipes = false, include_swipe = false } = options;
        const includeSwipes = include_swipes || include_swipe;
        
        if (!chat || !Array.isArray(chat)) {
            throw new Error('聊天数组不可用');
        }

        let start, end;
        const rangeStr = String(range);
        
        if (rangeStr.match(/^(-?\d+)$/)) {
            const value = Number(rangeStr);
            start = end = value < 0 ? chat.length + value : value;
        } else {
            const match = rangeStr.match(/^(-?\d+)-(-?\d+)$/);
            if (!match) {
                throw new Error(`无效的消息范围: ${range}`);
            }
            const [, s, e] = match;
            const startVal = Number(s) < 0 ? chat.length + Number(s) : Number(s);
            const endVal = Number(e) < 0 ? chat.length + Number(e) : Number(e);
            start = Math.min(startVal, endVal);
            end = Math.max(startVal, endVal);
        }

        if (start < 0 || end >= chat.length || start > end) {
            throw new Error(`消息范围超出界限: ${range}`);
        }

        const getRole = (msg) => {
            if (msg.is_system) return 'system';
            return msg.is_user ? 'user' : 'assistant';
        };

        const messages = [];
        for (let i = start; i <= end; i++) {
            const msg = chat[i];
            if (!msg) continue;

            const msgRole = getRole(msg);

            if (role !== 'all' && msgRole !== role) continue;

            if (hide_state !== 'all') {
                if ((hide_state === 'hidden') !== msg.is_system) continue;
            }

            const swipe_id = msg.swipe_id ?? 0;
            const swipes = msg.swipes ?? [msg.mes];
            const swipes_data = msg.variables ?? [{}];
            const swipes_info = msg.swipes_info ?? [msg.extra ?? {}];

            if (includeSwipes) {
                messages.push({
                    message_id: i,
                    name: msg.name,
                    role: msgRole,
                    is_hidden: msg.is_system,
                    swipe_id: swipe_id,
                    swipes: swipes,
                    swipes_data: swipes_data,
                    swipes_info: swipes_info
                });
            } else {
                messages.push({
                    message_id: i,
                    name: msg.name,
                    role: msgRole,
                    is_hidden: msg.is_system,
                    message: msg.mes,
                    data: swipes_data[swipe_id],
                    extra: swipes_info[swipe_id]
                });
            }
        }

        return messages;
    }

    async setChatMessages(chat_messages, options = {}) {
        const { refresh = 'affected' } = options;

        if (!Array.isArray(chat_messages)) {
            throw new Error('chat_messages 必须是数组');
        }

        for (const chatMsg of chat_messages) {
            const msg = chat[chatMsg.message_id];
            if (!msg) continue;

            if (chatMsg.name !== undefined) msg.name = chatMsg.name;
            if (chatMsg.role !== undefined) msg.is_user = chatMsg.role === 'user';
            if (chatMsg.is_hidden !== undefined) msg.is_system = chatMsg.is_hidden;

            if (chatMsg.message !== undefined) {
                msg.mes = chatMsg.message;
                if (msg.swipes) {
                    msg.swipes[msg.swipe_id ?? 0] = chatMsg.message;
                }
            }

            if (chatMsg.data !== undefined) {
                if (!msg.variables) {
                    msg.variables = Array(msg.swipes?.length ?? 1).fill({});
                }
                msg.variables[msg.swipe_id ?? 0] = chatMsg.data;
            }

            if (chatMsg.extra !== undefined) {
                if (!msg.swipes_info) {
                    msg.swipes_info = Array(msg.swipes?.length ?? 1).fill({});
                }
                msg.extra = chatMsg.extra;
                msg.swipes_info[msg.swipe_id ?? 0] = chatMsg.extra;
            }
        }

        await saveChatConditional();

        if (refresh === 'all') {
            await reloadCurrentChat();
        } else if (refresh === 'affected') {
            for (const chatMsg of chat_messages) {
                const $mes = $(`div.mes[mesid="${chatMsg.message_id}"]`);
                if ($mes.length) {
                    const msg = chat[chatMsg.message_id];
                    $mes.find('.mes_text').empty().append(
                        messageFormatting(msg.mes, msg.name, msg.is_system, msg.is_user, chatMsg.message_id)
                    );
                }
            }
        }

        console.log(`[Amily助手] 已修改消息: ${chat_messages.map(m => m.message_id).join(', ')}`);
    }


    async setChatMessage(field_values, message_id, {
        swipe_id = 'current',
        refresh = 'display_and_render_current'
    } = {}) {
        field_values = typeof field_values === 'string' ? { message: field_values } : field_values;
        
        if (typeof swipe_id !== 'number' && swipe_id !== 'current') {
            throw new Error(`提供的 swipe_id 无效, 请提供 'current' 或序号, 你提供的是: ${swipe_id}`);
        }
        if (!['none', 'display_current', 'display_and_render_current', 'all'].includes(refresh)) {
            throw new Error(
                `提供的 refresh 无效, 请提供 'none', 'display_current', 'display_and_render_current' 或 'all', 你提供的是: ${refresh}`
            );
        }

        const chat_message = chat[message_id];
        if (!chat_message) {
            console.warn(`[Amily助手] 未找到第 ${message_id} 楼的消息`);
            return;
        }

        const add_swipes_if_required = () => {
            if (swipe_id === 'current') {
                return false;
            }

            if (swipe_id == 0 || (chat_message.swipes && swipe_id < chat_message.swipes.length)) {
                return true;
            }

            if (!chat_message.swipes) {
                chat_message.swipe_id = 0;
                chat_message.swipes = [chat_message.mes];
                chat_message.variables = [{}];
            }
            for (let i = chat_message.swipes.length; i <= swipe_id; ++i) {
                chat_message.swipes.push('');
                chat_message.variables.push({});
            }
            return true;
        };

        const swipe_id_previous_index = chat_message.swipe_id ?? 0;
        const swipe_id_to_set_index = swipe_id == 'current' ? swipe_id_previous_index : swipe_id;
        const swipe_id_to_use_index = refresh != 'none' ? swipe_id_to_set_index : swipe_id_previous_index;
        const message = field_values.message ??
            (chat_message.swipes ? chat_message.swipes[swipe_id_to_set_index] : undefined) ??
            chat_message.mes;

        const update_chat_message = () => {
            const message_demacroed = substituteParamsExtended(message);

            if (field_values.data) {
                if (!chat_message.variables) {
                    chat_message.variables = [];
                }
                chat_message.variables[swipe_id_to_set_index] = field_values.data;
            }

            if (chat_message.swipes) {
                chat_message.swipes[swipe_id_to_set_index] = message_demacroed;
                chat_message.swipe_id = swipe_id_to_use_index;
            }

            if (swipe_id_to_use_index === swipe_id_to_set_index) {
                chat_message.mes = message_demacroed;
            }
        };

        const update_partial_html = async (should_update_swipe) => {
            const mes_html = $(`div.mes[mesid="${message_id}"]`);
            if (!mes_html.length) {
                return;
            }

            if (should_update_swipe) {
                mes_html.find('.swipes-counter').text(`${swipe_id_to_use_index + 1}\u200b/\u200b${chat_message.swipes.length}`);
            }

            if (refresh != 'none') {
                mes_html
                    .find('.mes_text')
                    .empty()
                    .append(
                        messageFormatting(message, chat_message.name, chat_message.is_system, chat_message.is_user, message_id)
                    );
                if (refresh === 'display_and_render_current') {
                    await eventSource.emit(
                        chat_message.is_user ? event_types.USER_MESSAGE_RENDERED : event_types.CHARACTER_MESSAGE_RENDERED,
                        message_id
                    );
                }
            }
        };

        const should_update_swipe = add_swipes_if_required();
        update_chat_message();
        await saveChatConditional();
        
        if (refresh == 'all') {
            await reloadCurrentChat();
        } else {
            await update_partial_html(should_update_swipe);
        }

        console.log(
            `[Amily助手] 设置第 ${message_id} 楼消息, 选项: ${JSON.stringify({
                swipe_id,
                refresh,
            })}, 设置前使用的消息页: ${swipe_id_previous_index}, 设置的消息页: ${swipe_id_to_set_index}, 现在使用的消息页: ${swipe_id_to_use_index}`
        );
    }


    async createChatMessages(chat_messages, options = {}) {
        const { insert_at = 'end', refresh = 'all' } = options;

        let insertIndex = insert_at;
        if (insert_at !== 'end') {
            insertIndex = insert_at < 0 ? chat.length + insert_at : insert_at;
            if (insertIndex < 0 || insertIndex > chat.length) {
                throw new Error(`无效的插入位置: ${insert_at}`);
            }
        }

        const newMessages = chat_messages.map(msg => ({
            name: msg.name ?? (msg.role === 'user' ? name1 : name2),
            is_user: msg.role === 'user',
            is_system: msg.is_hidden ?? false,
            mes: msg.message,
            variables: [msg.data ?? {}]
        }));

        if (insertIndex === 'end') {
            chat.push(...newMessages);
        } else {
            chat.splice(insertIndex, 0, ...newMessages);
        }

        await saveChatConditional();

        if (refresh === 'affected' && insertIndex === 'end') {
            newMessages.forEach(msg => addOneMessage(msg));
        } else if (refresh === 'all') {
            await reloadCurrentChat();
        }

        console.log(`[Amily助手] 已创建 ${chat_messages.length} 条消息`);
    }

    async deleteChatMessages(message_ids, options = {}) {
        const { refresh = 'all' } = options;

        const validIds = message_ids
            .map(id => id < 0 ? chat.length + id : id)
            .filter(id => id >= 0 && id < chat.length)
            .sort((a, b) => b - a); // 从后往前删除

        for (const id of validIds) {
            chat.splice(id, 1);
        }

        await saveChatConditional();

        if (refresh === 'all') {
            await reloadCurrentChat();
        }

        console.log(`[Amily助手] 已删除消息: ${validIds.join(', ')}`);
    }

    async getLorebooks() {
        return [...world_names];
    }

    async getCharLorebooks(options = { type: 'all' }) {
        try {
            const context = getContext();
            if (!context || context.characterId === undefined) {
                console.warn('[Amily助手] 无法获取当前角色上下文');
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
            const positionMap = { 
                0: 'before_character_definition', 
                1: 'after_character_definition', 
                2: 'before_author_note', 
                3: 'after_author_note', 
                4: 'at_depth_as_system' 
            };
            return Object.entries(bookData.entries).map(([uid, entry]) => ({
                uid: parseInt(uid),
                comment: entry.comment || '无标题条目',
                content: entry.content || '',
                key: entry.key || [],
                keys: entry.key || [],
                enabled: !entry.disable,
                constant: entry.constant || false,
                position: positionMap[entry.position] || 'at_depth_as_system', 
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
                console.error(`[Amily助手] 更新失败：找不到世界书《${bookName}》`);
                return false;
            }
            for (const entryUpdate of entries) {
                const existingEntry = bookData.entries[entryUpdate.uid];
                if (existingEntry) {
                    if (entryUpdate.content !== undefined) existingEntry.content = entryUpdate.content;
                    if (entryUpdate.enabled !== undefined) existingEntry.disable = !entryUpdate.enabled;
                    if (entryUpdate.comment !== undefined) existingEntry.comment = entryUpdate.comment;
                    if (entryUpdate.key !== undefined) existingEntry.key = entryUpdate.key;
                    if (entryUpdate.keys !== undefined) existingEntry.key = entryUpdate.keys;
                    if (entryUpdate.constant !== undefined) existingEntry.constant = entryUpdate.constant;
                    if (entryUpdate.type === 'constant') existingEntry.constant = true;
                    if (entryUpdate.type === 'selective') existingEntry.constant = false;
                    if (entryUpdate.position !== undefined) {
                        const positionMap = { 
                            'before_character_definition': 0, 
                            'after_character_definition': 1, 
                            'before_author_note': 2, 
                            'after_author_note': 3, 
                            'at_depth': 4, 
                            'at_depth_as_system': 4 
                        };
                        existingEntry.position = positionMap[entryUpdate.position] ?? 4;
                    }
                    if (entryUpdate.depth !== undefined) existingEntry.depth = entryUpdate.depth;
                }
            }
            await saveWorldInfo(bookName, bookData, true);
            reloadEditor(bookName);
            eventSource.emit(event_types.WORLD_INFO_UPDATED, bookName);
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
                console.warn(`[Amily助手] 世界书《${bookName}》不存在，将自动创建`);
                await this.createLorebook(bookName);
                bookData = await loadWorldInfo(bookName);
                if (!bookData) {
                    throw new Error(`创建并加载世界书《${bookName}》失败`);
                }
            }

            for (const newEntryData of entries) {
                const newEntry = createWorldInfoEntry(bookName, bookData);
                const positionMap = { 
                    'before_character_definition': 0, 
                    'after_character_definition': 1, 
                    'before_author_note': 2, 
                    'after_author_note': 3, 
                    'at_depth': 4, 
                    'at_depth_as_system': 4 
                };
                Object.assign(newEntry, {
                    comment: newEntryData.comment || '新条目',
                    content: newEntryData.content || '',
                    key: newEntryData.keys || newEntryData.key || [],
                    constant: newEntryData.type === 'constant' ? true : (newEntryData.constant || false),
                    position: typeof newEntryData.position === 'string' ? (positionMap[newEntryData.position] ?? 4) : (newEntryData.position ?? 4),
                    depth: newEntryData.depth ?? 998,
                    disable: !(newEntryData.enabled ?? true),
                });
                if (newEntryData.type === 'selective') newEntry.constant = false;
            }
            await saveWorldInfo(bookName, bookData, true);
            reloadEditor(bookName);
            return true;
        } catch (error) {
            console.error(`[Amily助手] 在世界书《${bookName}》中创建新条目时出错:`, error);
            return false;
        }
    }

    async createLorebook(bookName) {
        try {
            if (world_names.includes(bookName)) {
                console.warn(`[Amily助手] 创建失败：世界书《${bookName}》已存在`);
                return false;
            }
            await createNewWorldInfo(bookName);
            if (!world_names.includes(bookName)) {
                world_names.push(bookName);
                world_names.sort();
            }
            document.dispatchEvent(new CustomEvent('amily-lorebook-created', { detail: { bookName } }));
            return true;
        } catch (error) {
            console.error(`[Amily助手] 创建世界书《${bookName}》时出错:`, error);
            return false;
        }
    }

    // ==================== 斜杠命令相关 ====================

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

    // ==================== 工具方法 ====================

    async loadWorldInfo(bookName) {
        return await loadWorldInfo(bookName);
    }

    async saveWorldInfo(bookName, data, isWorldInfo) {
        await saveWorldInfo(bookName, data, isWorldInfo);
    }

    getLastMessageId() {
        return chat.length - 1;
    }
}

export const amilyHelper = new AmilyHelper();


export function initializeAmilyHelper() {
    if (!window.AmilyHelper) {
        window.AmilyHelper = amilyHelper;
        console.log('[Amily2] AmilyHelper 已成功初始化并附加到 window 对象');
    }
}

// ==================== iframe 通信 API ====================


export function makeRequest(request, data) {
    return new Promise((resolve, reject) => {
        const uid = Date.now() + Math.random();
        const callbackRequest = `${request}_callback`;

        function handleMessage(event) {
            const msgData = event.data || {};
            if (msgData.request === callbackRequest && msgData.uid === uid) {
                window.removeEventListener('message', handleMessage);
                if (msgData.error) {
                    reject(new Error(msgData.error));
                } else {
                    resolve(msgData.result);
                }
            }
        }

        window.addEventListener('message', handleMessage);

        setTimeout(() => {
            window.removeEventListener('message', handleMessage);
            reject(new Error(`请求 '${request}' 超时 (30秒)`));
        }, 30000);

        window.parent.postMessage({
            source: 'amily2-iframe-request',
            request: request,
            uid: uid,
            data: data
        }, '*');
    });
}

// ==================== 主窗口 API ====================

const apiHandlers = new Map();


export function registerApiHandler(request, handler) {
    if (apiHandlers.has(request)) {
        console.warn(`[Amily2-IframeAPI] 覆盖请求处理器: ${request}`);
    }
    apiHandlers.set(request, handler);
}


export function initializeApiListener() {
    window.addEventListener('message', async (event) => {
        const data = event.data || {};
        if (data.source !== 'amily2-iframe-request' || !data.request || data.uid === undefined) {
            return;
        }

        const handler = apiHandlers.get(data.request);
        const callbackRequest = `${data.request}_callback`;

        if (!handler) {
            console.error(`[Amily2-IframeAPI] 收到未知请求: ${data.request}`);
            event.source.postMessage({
                request: callbackRequest,
                uid: data.uid,
                error: `未注册请求 '${data.request}' 的处理器`
            }, '*');
            return;
        }

        try {
            const result = await handler(data.data, event);
            event.source.postMessage({
                request: callbackRequest,
                uid: data.uid,
                result: result
            }, '*');
        } catch (error) {
            console.error(`[Amily2-IframeAPI] 执行处理器 '${data.request}' 时出错:`, error);
            event.source.postMessage({
                request: callbackRequest,
                uid: data.uid,
                error: error.message || String(error)
            }, '*');
        }
    });
    console.log('[Amily2-IframeAPI] 主窗口监听器已初始化');
}
