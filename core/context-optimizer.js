import { log } from "./table-system/logger.js";
import { getContext, extension_settings } from "/scripts/extensions.js";
import { eventSource, event_types } from "/script.js";
import { extensionName } from "../utils/settings.js";

function createArchiveBuffer() {
    return Object.create(null);
}

function collectDataToBuffer(buffer, tableName, rowObj) {
    if (!Object.prototype.hasOwnProperty.call(buffer, tableName)) {
        buffer[tableName] = {
            headers: Object.keys(rowObj),
            rows: []
        };
    } else {
        const newKeys = Object.keys(rowObj);
        newKeys.forEach(k => {
            if (!buffer[tableName].headers.includes(k)) {
                buffer[tableName].headers.push(k);
            }
        });
    }
    buffer[tableName].rows.push(rowObj);
}

function flushBufferToMarkdown(buffer) {
    let output = "";
    const tableNames = Object.keys(buffer);

    if (tableNames.length === 0) return "";

    for (const tableName of tableNames) {
        const { headers, rows: bufferedRows } = buffer[tableName];
        const rows = [...bufferedRows];
        if (rows.length === 0) continue;

        const firstColKey = headers[0];
        const firstColVal = rows[0] ? rows[0][firstColKey] : '';
        const isIndexCol = (firstColKey && (firstColKey.includes('索引') || firstColKey.includes('Index'))) ||
                           (typeof firstColVal === 'string' && /^\s*M\d+/.test(firstColVal));

        if (isIndexCol) {
            rows.sort((a, b) => {
                const valA = String(a[firstColKey] || '');
                const valB = String(b[firstColKey] || '');
                return valA.localeCompare(valB, undefined, { numeric: true });
            });
        } else {

            rows.reverse();
        }

        output += `\n# ${tableName}档案\n`;
        output += `| ${headers.join(' | ')} |\n`;
        output += `|${headers.map(() => '---').join('|')}|\n`;

        for (const rowObj of rows) {
            const rowArr = headers.map(h => {
                const val = rowObj[h];
                let safeVal = (val === undefined || val === null) ? '' : String(val);
                safeVal = safeVal.replace(/\|/g, '\\|').replace(/\n/g, ' '); 
                return safeVal;
            });
            output += `| ${rowArr.join(' | ')} |\n`;
        }
        output += `\n`;
    }
    return output;
}

function collectArchiveBlocks(text, buffer) {
    const blockRegex = /【(.*?)档案[:：]\s*.*?】\s*((?:-\s*.*?[:：].*?(?:\r?\n|$))+)/g;
    const itemRegex = /-\s*(.*?)[:：]\s*(.*?)(?:\r?\n|$)/g;
    let blockCount = 0;

    const cleanText = text.replace(blockRegex, (match, tableName, content) => {
        const normalizedTableName = tableName.trim();
        if (!normalizedTableName) return match;
        const rowObj = Object.create(null);
        
        let itemMatch;
        itemRegex.lastIndex = 0;

        while ((itemMatch = itemRegex.exec(content)) !== null) {
            const key = itemMatch[1].trim();
            const val = itemMatch[2].trim();
            if (key) {
                rowObj[key] = val;
            }
        }

        if (Object.keys(rowObj).length > 0) {
            collectDataToBuffer(buffer, normalizedTableName, rowObj);
            blockCount += 1;
            return '';
        }

        // 无有效键值时保留原文，避免解析失败造成请求内容丢失。
        return match;
    });

    return { cleanText, blockCount };
}

function appendMergedArchive(content, markdown) {
    if (!content) return markdown.trimStart();
    return content + (content.endsWith('\n') ? '' : '\n') + markdown.trimStart();
}

function archiveRoleAuthority(role) {
    switch (String(role || '').toLowerCase()) {
        case 'assistant':
        case 'tool':
        case 'function':
            return 0;
        case 'user':
            return 1;
        case 'developer':
            return 2;
        case 'system':
            return 3;
        default:
            return 0;
    }
}

function pickArchiveTargetIndex(sources) {
    let selected = sources[0];
    for (const source of sources.slice(1)) {
        const selectedAuthority = archiveRoleAuthority(selected.role);
        const sourceAuthority = archiveRoleAuthority(source.role);
        if (sourceAuthority < selectedAuthority
            || (sourceAuthority === selectedAuthority && source.index > selected.index)) {
            selected = source;
        }
    }
    return selected.index;
}

/** Merge every archive block in a text prompt exactly once. */
export function optimizeArchivePrompt(prompt) {
    if (typeof prompt !== 'string') {
        return Object.freeze({ prompt, modified: false, blockCount: 0 });
    }
    const buffer = createArchiveBuffer();
    const { cleanText, blockCount } = collectArchiveBlocks(prompt, buffer);
    const markdown = flushBufferToMarkdown(buffer);
    if (blockCount === 0 || !markdown) {
        return Object.freeze({ prompt, modified: false, blockCount: 0 });
    }
    return Object.freeze({
        prompt: appendMergedArchive(cleanText, markdown),
        modified: true,
        blockCount,
    });
}

/**
 * Merge archive blocks across one complete chat-completion request. The merged
 * representation is attached to the least-authoritative source message so
 * content is never promoted into a stronger prompt role.
 */
export function optimizeArchiveChat(chat) {
    if (!Array.isArray(chat)) {
        return Object.freeze({ chat, modified: false, blockCount: 0, modifiedMessageCount: 0 });
    }

    const buffer = createArchiveBuffer();
    const nextChat = chat.map(message => ({ ...message }));
    const sources = [];
    let blockCount = 0;

    for (let index = 0; index < nextChat.length; index += 1) {
        const message = nextChat[index];
        if (typeof message.content !== 'string') continue;
        const result = collectArchiveBlocks(message.content, buffer);
        if (result.blockCount === 0) continue;
        message.content = result.cleanText;
        blockCount += result.blockCount;
        sources.push({ index, role: message.role });
    }

    const markdown = flushBufferToMarkdown(buffer);
    if (blockCount === 0 || !markdown) {
        return Object.freeze({ chat, modified: false, blockCount: 0, modifiedMessageCount: 0 });
    }

    const targetIndex = pickArchiveTargetIndex(sources);
    nextChat[targetIndex].content = appendMergedArchive(nextChat[targetIndex].content, markdown);
    return Object.freeze({
        chat: nextChat,
        modified: true,
        blockCount,
        modifiedMessageCount: sources.length,
        targetIndex,
    });
}

function handlePromptProcessing(data) {
    // 【V146.5】检查上下文优化开关
    const settings = extension_settings[extensionName];
    if (settings && settings.context_optimization_enabled === false) {
        // log('[ContextOptimizer] 上下文优化已禁用，跳过处理。', 'info');
        return;
    }

    if (!data) return;

    if (typeof data.prompt === 'string') {
        const result = optimizeArchivePrompt(data.prompt);
        if (result.modified) {
            data.prompt = result.prompt;
            log(`[ContextOptimizer] 已合并 ${result.blockCount} 个世界书档案块 (Text Mode)。`, 'success');
        }

    } else if (Array.isArray(data.chat)) {
        console.log('[ContextOptimizer] 检测到 Chat Completion 格式...');
        const result = optimizeArchiveChat(data.chat);
        if (result.modified) {
            console.log(`[ContextOptimizer] 已从 ${result.modifiedMessageCount} 条消息合并 ${result.blockCount} 个档案块。`);
            // 全量替换，确保生效
            data.chat.splice(0, data.chat.length, ...result.chat);
            log('[ContextOptimizer] 已优化上下文：同次请求的分散世界书条目已统一合并 (Chat Mode - In Place)。', 'success');
        }

    }
}

/**
 * 注册监听器
 */
export function registerContextOptimizerMacros() {
    console.log('[ContextOptimizer] 正在注册监听器...');
    const context = getContext();
    
    if (context) {
        console.log('[ContextOptimizer] Context APIs:', Object.keys(context));
    }

    if (context && context.registerChatCompletionModifier) {
        context.registerChatCompletionModifier((chat) => {
            console.log('[ContextOptimizer] ChatCompletionModifier 触发');
            const data = { chat: chat };
            handlePromptProcessing(data);
            return data.chat;
        });
        log('[ContextOptimizer] 已注册 Chat Completion Modifier。', 'success');

    } else if (context && context.registerPromptModifier) {
            context.registerPromptModifier((prompt) => {
                console.log('[ContextOptimizer] PromptModifier 触发');
                const data = { prompt: prompt };
                handlePromptProcessing(data);
                return data.prompt;
            });
            log('[ContextOptimizer] 已注册 Prompt Modifier (正则模式)。', 'success');

    } else if (eventSource) {
        eventSource.on('chat_completion_prompt_ready', (...args) => {
            if (args[0] && typeof args[0] === 'object') {
                 handlePromptProcessing(args[0]);
            }
        });
        
        eventSource.on(event_types.GENERATION_STARTED, (...args) => {
             if (args.length > 1 && args[1] && typeof args[1].prompt === 'string') {
                  handlePromptProcessing(args[1]);
             } else if (args[0] && typeof args[0].prompt === 'string') {
                  handlePromptProcessing(args[0]);
             }
        });
        
        log('[ContextOptimizer] 已绑定事件监听 (Text/Chat 双模式)。', 'info');
    } else {
        console.error('[ContextOptimizer] 无法获取 eventSource。');
    }
}
export function resetContextBuffer() {
}
