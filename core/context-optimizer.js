import { log } from "./table-system/logger.js";
import { getContext } from "/scripts/extensions.js";
import { eventSource, event_types } from "/script.js";

function collectDataToBuffer(buffer, tableName, rowObj) {
    if (!buffer[tableName]) {
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
        const { headers, rows } = buffer[tableName];
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

function processText(text) {
    const blockRegex = /【(.*?)档案[:：]\s*.*?】\s*((?:-\s*.*?[:：].*?(?:\r?\n|$))+)/g;
    const itemRegex = /-\s*(.*?)[:：]\s*(.*?)(?:\r?\n|$)/g;
    
    const buffer = {};
    let found = false;

    const cleanText = text.replace(blockRegex, (match, tableName, content) => {
        found = true;
        const rowObj = {};
        
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
            collectDataToBuffer(buffer, tableName, rowObj);
        }
        
        return ""; // 移除原始文本
    });

    return { cleanText, buffer, found };
}

function handlePromptProcessing(data) {
    if (!data) return;

    if (typeof data.prompt === 'string') {
        const { cleanText, buffer, found } = processText(data.prompt);
        if (found) {
            const mergedTable = flushBufferToMarkdown(buffer);
            if (mergedTable) {
                data.prompt = cleanText + "\n" + mergedTable;
                log('[ContextOptimizer] 已优化上下文：合并了分散的世界书条目 (Text Mode)。', 'success');
            }
        }

    } else if (Array.isArray(data.chat)) {
        console.log('[ContextOptimizer] 检测到 Chat Completion 格式...');
        
        const newChat = [];
        let modifiedCount = 0;

        for (const msg of data.chat) {
            const newMsg = { ...msg };
            
            if (typeof newMsg.content === 'string') {
                const { cleanText, buffer, found } = processText(newMsg.content);
                
                if (found) {
                    const mergedTable = flushBufferToMarkdown(buffer);
                    if (mergedTable) {
                        newMsg.content = cleanText + "\n" + mergedTable;
                        modifiedCount++;
                    }
                }
            }
            newChat.push(newMsg);
        }

        if (modifiedCount > 0) {
            console.log(`[ContextOptimizer] 已原地优化 ${modifiedCount} 条消息中的表格数据。`);
            
            // 全量替换，确保生效
            data.chat.splice(0, data.chat.length, ...newChat);
            log('[ContextOptimizer] 已优化上下文：合并了分散的世界书条目 (Chat Mode - In Place)。', 'success');
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
