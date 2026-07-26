/**
 * @file 旧版 <Amily2Edit> 文本格式的解析器 + executeCommands 入口。
 *
 * Phase 0 重构后职责收窄：
 *   - 仅负责把 LLM 返回的文本块解析成 Operation[]（legacy formatter 角色）
 *   - 推演下推到 actions/applyOperations.js，本文件不再持有 insertRow/updateRow/deleteRow 实现
 *
 * 对外 API：
 *   - parseToOperations(text)        : 纯解析，文本 → Op[]（Phase B legacy formatter 直接复用）
 *   - executeCommands(text, state)   : 解析 + 推演，返回历史 shape { finalState, hasChanges, changes }
 *
 * 等 Phase B 引入 formatters/ 目录后，本文件改名为 formatters/legacy.js。
 *
 * @typedef {import('./dto/Operation.js').Operation} Operation
 * @typedef {import('./dto/Table.js').TableState} TableState
 */

import { log } from './logger.js';
import { applyOperations } from './actions/applyOperations.js';

const ALLOWED_FN_NAMES = new Set(['insertRow', 'updateRow', 'deleteRow']);

/**
 * 把单行函数调用文本解析为 { name, args } 中间表示。
 * 内部用，不导出。args 是位置参数数组，待 _argsToOperation 转成 Operation 对象。
 * @param {string} callString
 * @returns {{ name: string, args: any[] } | null}
 */
function parseFunctionCall(callString) {
    const match = callString.trim().match(/^(\w+)\s*([(（])([\s\S]*)([)）])\s*[;；]?\s*$/u);
    if (!match) {
        log(`指令格式错误，无法解析: "${callString}"`, 'error');
        return null;
    }

    const functionName = match[1];
    const openingParenthesis = match[2];
    const argsString = match[3];
    const closingParenthesis = match[4];
    if ((openingParenthesis === '(' && closingParenthesis !== ')')
        || (openingParenthesis === '（' && closingParenthesis !== '）')) {
        log(`指令括号不匹配，无法解析: "${callString}"`, 'error');
        return null;
    }

    if (!ALLOWED_FN_NAMES.has(functionName)) {
        log(`检测到非法函数调用: "${functionName}"。已阻止执行。`, 'error');
        return null;
    }

    try {

        const args = [];
        let currentArg = '';
        let inQuote = false;
        let quoteChar = '';
        /** @type {string[]} */
        const braceStack = [];

        for (let i = 0; i < argsString.length; i++) {
            const char = argsString[i];
            const escaped = isEscaped(argsString, i);

            if (inQuote) {
                if (char === quoteChar && !escaped) {
                    inQuote = false;
                    currentArg += normalizedClosingQuote(char);
                } else {
                    currentArg += char;
                }
                continue;
            }

            const openingQuote = getOpeningQuote(char);
            if (openingQuote && !escaped) {
                inQuote = true;
                quoteChar = openingQuote.close;
                currentArg += openingQuote.normalized;
                continue;
            }

            if (isClosingCurlyQuote(char) && !escaped) {
                throw new Error(`孤立的右引号 "${char}"`);
            }

            if (char === '{' || char === '[') {
                braceStack.push(char);
                currentArg += char;
            } else if (char === '}' || char === ']') {
                const expectedOpening = char === '}' ? '{' : '[';
                if (braceStack.pop() !== expectedOpening) {
                    throw new Error(`括号不匹配: "${char}"`);
                }
                currentArg += char;
            } else if ((char === ',' || char === '，' || char === ';' || char === '；')
                && braceStack.length === 0) {
                if (!currentArg.trim()) {
                    throw new Error('存在空参数');
                }
                args.push(parseValue(currentArg));
                currentArg = '';
            } else {
                currentArg += normalizeStructuralPunctuation(char);
            }
        }
        if (inQuote) {
            throw new Error('字符串引号未闭合');
        }
        if (braceStack.length > 0) {
            throw new Error('对象或数组括号未闭合');
        }
        if (currentArg.trim()) {
            args.push(parseValue(currentArg));
        } else if (argsString.trim() && args.length > 0) {
            throw new Error('参数列表不能以分隔符结尾');
        }

        return { name: functionName, args: args };
    } catch (e) {
        log(`解析函数 "${functionName}" 的参数时出错: ${e.message}`, 'error');
        return null;
    }
}

function getOpeningQuote(char) {
    if (char === '"') return { close: '"', normalized: '"' };
    if (char === "'") return { close: "'", normalized: "'" };
    if (char === '“') return { close: '”', normalized: '"' };
    if (char === '‘') return { close: '’', normalized: '"' };
    return null;
}

function isClosingCurlyQuote(char) {
    return char === '”' || char === '’';
}

function normalizedClosingQuote(char) {
    return char === '”' || char === '’' ? '"' : char;
}

function isEscaped(text, index) {
    let slashCount = 0;
    for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
        slashCount++;
    }
    return slashCount % 2 === 1;
}

function normalizeStructuralPunctuation(char) {
    if (char === '，') return ',';
    if (char === '：') return ':';
    if (char === '；') return ';';
    return char;
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

/**
 * 把 parseFunctionCall 返回的位置参数数组转成 Operation 对象。
 * @param {string} name
 * @param {any[]} args
 * @returns {Operation | null}
 */
function _argsToOperation(name, args) {
    if (name === 'insertRow') {
        if (args.length !== 2
            || !isNonNegativeInteger(args[0])
            || !isPlainDataObject(args[1])) {
            log('insertRow 参数无效：需要 (非负整数 tableIndex, data 对象)。', 'error');
            return null;
        }
        return /** @type {Operation} */ ({ op: 'insertRow', tableIndex: args[0], data: args[1] });
    }
    if (name === 'updateRow') {
        if (args.length !== 3
            || !isNonNegativeInteger(args[0])
            || !isNonNegativeInteger(args[1])
            || !isPlainDataObject(args[2])) {
            log('updateRow 参数无效：需要 (非负整数 tableIndex, 非负整数 rowIndex, data 对象)。', 'error');
            return null;
        }
        return /** @type {Operation} */ ({ op: 'updateRow', tableIndex: args[0], rowIndex: args[1], data: args[2] });
    }
    if (name === 'deleteRow') {
        if (args.length !== 2
            || !isNonNegativeInteger(args[0])
            || !isNonNegativeInteger(args[1])) {
            log('deleteRow 参数无效：需要 (非负整数 tableIndex, 非负整数 rowIndex)。', 'error');
            return null;
        }
        return /** @type {Operation} */ ({ op: 'deleteRow', tableIndex: args[0], rowIndex: args[1] });
    }
    return null;
}

function isNonNegativeInteger(value) {
    return Number.isInteger(value) && value >= 0;
}

function isPlainDataObject(value) {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * 把 LLM 返回的文本块解析为 Operation[]。
 * 不在文本中找到 <Amily2Edit> 块时返回空数组（不视为错误）。
 *
 * @param {string} aiResponseText
 * @returns {Operation[]}
 */
export function parseToOperations(aiResponseText) {
    const commandBlockRegex = /<Amily2Edit>([\s\S]*?)<\/Amily2Edit>/;
    const match = (aiResponseText || '').match(commandBlockRegex);
    if (!match) return [];

    const commandBlock = match[1].replace(/<!--|-->/g, '').trim();
    if (!commandBlock) return [];

    const commands = commandBlock.split('\n').filter(line => line.trim() !== '');
    if (commands.length === 0) return [];

    /** @type {Operation[]} */
    const ops = [];
    for (const commandString of commands) {
        const trimmed = commandString.trim();
        if (!/^(?:insertRow|updateRow|deleteRow)\b/u.test(trimmed)) {
            continue;
        }
        const parsed = parseFunctionCall(trimmed);
        if (!parsed) return [];
        const op = _argsToOperation(parsed.name, parsed.args);
        if (!op) return [];
        ops.push(op);
    }
    return ops;
}

/**
 * 解析 LLM 文本指令并推演到 state 上。
 * 历史 API，调用方期望返回 { finalState, hasChanges, changes }。
 *
 * @param {string} aiResponseText
 * @param {TableState} initialState
 * @returns {{ finalState: TableState, hasChanges: boolean, changes: import('./dto/Change.js').Change[] }}
 */
export function executeCommands(aiResponseText, initialState) {
    const ops = parseToOperations(aiResponseText);

    if (ops.length === 0) {
        return { finalState: initialState, hasChanges: false, changes: [] };
    }

    log(`检测到 ${ops.length} 条 AI 指令，开始推演...`, 'info');

    const { state, changes } = applyOperations(initialState, ops);
    return { finalState: state, hasChanges: changes.length > 0, changes };
}
