import { log } from './logger.js';

function insertRow(state, tableIndex, data) {
    if (!state[tableIndex]) {
        log(`AI指令错误：尝试在不存在的表格索引 ${tableIndex} 中插入行。`, 'error');
        return { state, changes: [] };
    }
    
    // 【安全检查】确保 data 是对象
    if (typeof data !== 'object' || data === null) {
        log(`AI指令错误：insertRow 的 data 参数必须是对象，实际收到: ${typeof data} (${data})`, 'error');
        return { state, changes: [] };
    }

    const table = state[tableIndex];
    const colCount = table.headers.length;
    const newRow = Array(colCount).fill('');
    const changes = [];
    const newRowIndex = table.rows.length;

    for (const colIndex in data) {
        const cIndex = parseInt(colIndex, 10);
        if (cIndex < colCount) {
            newRow[cIndex] = data[colIndex];
            changes.push({ type: 'update', tableIndex, rowIndex: newRowIndex, colIndex: cIndex });
        }
    }
    table.rows.push(newRow);

    // 同步更新 rowStatuses
    if (!table.rowStatuses) {
        table.rowStatuses = Array(table.rows.length - 1).fill('normal');
    }
    table.rowStatuses.push('normal');

    return { state, changes };
}

function updateRow(state, tableIndex, rowIndex, data) {
    if (!state[tableIndex]) {
        log(`AI指令错误：尝试更新不存在的表格 ${tableIndex}。`, 'error');
        return { state, changes: [] };
    }

    // 【安全检查】确保 data 是对象
    if (typeof data !== 'object' || data === null) {
        log(`AI指令错误：updateRow 的 data 参数必须是对象，实际收到: ${typeof data} (${data})`, 'error');
        return { state, changes: [] };
    }

    const table = state[tableIndex];

    if (rowIndex >= table.rows.length) {
        log(`AI指令修正：updateRow 的行索引 ${rowIndex} 超出范围，自动转换为 insertRow。`, 'warn');
        return insertRow(state, tableIndex, data);
    }

    const row = table.rows[rowIndex];
    const changes = [];
    for (const colIndex in data) {
        const cIndex = parseInt(colIndex, 10);
        if (cIndex < row.length) {
            row[cIndex] = data[colIndex];
            changes.push({ type: 'update', tableIndex, rowIndex, colIndex: cIndex });
        }
    }
    return { state, changes };
}


function deleteRow(state, tableIndex, rowIndex) {
    const table = state[tableIndex];
    if (!table || !table.rows[rowIndex]) {
        log(`AI指令错误：尝试删除不存在的表格 ${tableIndex} 或行 ${rowIndex}。`, 'error');
        return { state, changes: [] };
    }

    if (!table.rowStatuses) {
        table.rowStatuses = Array(table.rows.length).fill('normal');
    }
    
    if (table.rowStatuses[rowIndex] !== 'pending-deletion') {
        table.rowStatuses[rowIndex] = 'pending-deletion';
        const changes = [{ type: 'delete', tableIndex, rowIndex }];
        return { state, changes };
    }

    return { state, changes: [] };
}


const allowedFunctions = {
    insertRow,
    updateRow,
    deleteRow,
};

function parseFunctionCall(callString) {
    const match = callString.trim().match(/(\w+)\((.*)\)/);
    if (!match) {
        log(`指令格式错误，无法解析: "${callString}"`, 'error');
        return null;
    }

    const functionName = match[1];
    const argsString = match[2];

    if (!allowedFunctions[functionName]) {
        log(`检测到非法函数调用: "${functionName}"。已阻止执行。`, 'error');
        return null;
    }

    try {

        const args = [];
        let currentArg = '';
        let inQuote = false;
        let quoteChar = '';
        let braceDepth = 0; 
        
        for (let i = 0; i < argsString.length; i++) {
            const char = argsString[i];
            
            if ((char === '"' || char === "'") && (i === 0 || argsString[i-1] !== '\\')) {
                if (!inQuote) {
                    inQuote = true;
                    quoteChar = char;
                } else if (char === quoteChar) {
                    inQuote = false;
                }
                currentArg += char;
            } else if (!inQuote) {
                if (char === '{' || char === '[') {
                    braceDepth++;
                    currentArg += char;
                } else if (char === '}' || char === ']') {
                    braceDepth--;
                    currentArg += char;
                } else if (char === ',' && braceDepth === 0) {
                    args.push(parseValue(currentArg));
                    currentArg = '';
                } else {
                    currentArg += char;
                }
            } else {
                currentArg += char;
            }
        }
        if (currentArg.trim()) {
            args.push(parseValue(currentArg));
        }

        return { name: functionName, args: args };
    } catch (e) {
        log(`解析函数 "${functionName}" 的参数时出错: ${e.message}`, 'error');
        return null;
    }
}

function parseValue(val) {
    val = val.trim();
    if (val === 'true') return true;
    if (val === 'false') return false;
    if (val === 'null') return null;
    if (val === 'undefined') return undefined;
    if (!isNaN(Number(val)) && val !== '') return Number(val);
    
    if (val.startsWith('"') && val.endsWith('"')) {
         try { return JSON.parse(val); } catch (e) { return val.slice(1, -1); }
    }
    if (val.startsWith("'") && val.endsWith("'")) {
        return val.slice(1, -1);
    }

    if ((val.startsWith('{') && val.endsWith('}')) || (val.startsWith('[') && val.endsWith(']'))) {
        try {
            return JSON.parse(val);
        } catch (e) {
            // 尝试手动解析以处理嵌套引号等格式错误
            const manualParsed = tryParseObject(val);
            if (manualParsed) return manualParsed;

            let fixedKeys = val.replace(/([{,]\s*)(\d+)(\s*:)/g, '$1"$2"$3');
            try {
                return JSON.parse(fixedKeys);
            } catch (e2) {
                let fixedQuotes = fixedKeys.replace(/'/g, '"');
                try {
                    return JSON.parse(fixedQuotes);
                } catch (e3) {
                    let fixedAllKeys = val.replace(/([{,]\s*)([a-zA-Z0-9_]+)(\s*:)/g, '$1"$2"$3');
                    try {
                         return JSON.parse(fixedAllKeys);
                    } catch (e4) {
                         return val;
                    }
                }
            }
        }
    }
    return val;
}

function tryParseObject(str) {
    if (!str.startsWith('{') || !str.endsWith('}')) return null;
    
    let content = str.slice(1, -1);
    const result = {};
    let hasMatch = false;
    
    const strings = [];
    let placeholderIndex = 0;
    
    // 提取字符串并替换为占位符，避免正则在字符串内部匹配
    const stringRegex = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g;
    content = content.replace(stringRegex, (match) => {
        const placeholder = `__STR_${placeholderIndex}__`;
        strings.push(match);
        placeholderIndex++;
        return placeholder;
    });
    
    // 匹配键：(开头或逗号/分号/冒号) + (数字 或 字母数字下划线 或 占位符) + 冒号
    const keyRegex = /(?:^|[,;:]+\s*)(?:(\d+)|([a-zA-Z0-9_]+)|(__STR_\d+__))\s*:/g;
    
    let match;
    let lastIndex = 0;
    let lastKey = null;
    
    while ((match = keyRegex.exec(content)) !== null) {
        hasMatch = true;
        if (lastKey !== null) {
            let valStr = content.slice(lastIndex, match.index).trim();
            valStr = valStr.replace(/[,;:]+$/, '').trim();
            
            let actualKey = restoreStrings(lastKey, strings);
            result[actualKey] = restoreStrings(valStr, strings);
        }
        
        lastKey = match[1] || match[2] || match[3];
        lastIndex = match.index + match[0].length;
    }
    
    if (lastKey !== null) {
        let valStr = content.slice(lastIndex).trim();
        valStr = valStr.replace(/[,;:]+$/, '').trim();
        
        let actualKey = restoreStrings(lastKey, strings);
        result[actualKey] = restoreStrings(valStr, strings);
    }
    
    return hasMatch ? result : null;
}

function restoreStrings(str, strings) {
    if (!str) return str;
    let restored = str;
    const placeholderRegex = /__STR_(\d+)__/g;
    restored = restored.replace(placeholderRegex, (match, index) => {
        return strings[parseInt(index, 10)];
    });
    return cleanValueStr(restored);
}

function cleanValueStr(str) {
    if ((str.startsWith('"') && str.endsWith('"')) || (str.startsWith("'") && str.endsWith("'"))) {
        return str.slice(1, -1);
    }
    return str;
}


export function executeCommands(aiResponseText, initialState) {
    const commandBlockRegex = /<Amily2Edit>([\s\S]*?)<\/Amily2Edit>/;
    const match = aiResponseText.match(commandBlockRegex);

    if (!match) {
        return { finalState: initialState, hasChanges: false, changes: [] };
    }

    log('检测到AI指令块，开始推演...', 'info');
    const commandBlock = match[1].replace(/<!--|-->/g, '').trim();
    if (!commandBlock) {
        return { finalState: initialState, hasChanges: false, changes: [] };
    }

    const commands = commandBlock.split('\n').filter(line => line.trim() !== '');
    if (commands.length === 0) {
        return { finalState: initialState, hasChanges: false, changes: [] };
    }

    let currentState = JSON.parse(JSON.stringify(initialState));
    let allChanges = [];

    commands.forEach(commandString => {
        const trimmedCommand = commandString.trim();
        if (trimmedCommand.startsWith('insertRow(') || 
            trimmedCommand.startsWith('deleteRow(') || 
            trimmedCommand.startsWith('updateRow(')) 
        {
            const parsed = parseFunctionCall(trimmedCommand);
            if (parsed) {
                try {
                    const result = allowedFunctions[parsed.name](currentState, ...parsed.args);
                    currentState = result.state;
                    if (result.changes && result.changes.length > 0) {
                        allChanges = allChanges.concat(result.changes);
                    }
                    log(`成功推演指令: ${commandString}`, 'success');
                } catch (e) {
                    log(`推演指令 "${commandString}" 时发生运行时错误: ${e.message}`, 'error');
                }
            }
        }
    });

    const hasChanges = allChanges.length > 0;
    return { finalState: currentState, hasChanges, changes: allChanges };
}
