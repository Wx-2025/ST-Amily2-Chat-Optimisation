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
        const tableIndex = normalizeLegacyIndex(args[0]);
        if (args.length !== 2
            || tableIndex === null
            || !isPlainDataObject(args[1])) {
            log('insertRow 参数无效：需要 (非负整数 tableIndex, data 对象)。', 'error');
            return null;
        }
        return /** @type {Operation} */ ({ op: 'insertRow', tableIndex, data: args[1] });
    }
    if (name === 'updateRow') {
        const tableIndex = normalizeLegacyIndex(args[0]);
        const rowIndex = normalizeLegacyIndex(args[1]);
        if (args.length !== 3
            || tableIndex === null
            || rowIndex === null
            || !isPlainDataObject(args[2])) {
            log('updateRow 参数无效：需要 (非负整数 tableIndex, 非负整数 rowIndex, data 对象)。', 'error');
            return null;
        }
        return /** @type {Operation} */ ({ op: 'updateRow', tableIndex, rowIndex, data: args[2] });
    }
    if (name === 'deleteRow') {
        const tableIndex = normalizeLegacyIndex(args[0]);
        const rowIndex = normalizeLegacyIndex(args[1]);
        if (args.length !== 2
            || tableIndex === null
            || rowIndex === null) {
            log('deleteRow 参数无效：需要 (非负整数 tableIndex, 非负整数 rowIndex)。', 'error');
            return null;
        }
        return /** @type {Operation} */ ({ op: 'deleteRow', tableIndex, rowIndex });
    }
    return null;
}

function normalizeLegacyIndex(value) {
    if (Number.isSafeInteger(value) && value >= 0) {
        return value;
    }
    if (typeof value !== 'string' || !/^[0-9]+$/u.test(value)) {
        return null;
    }
    const normalized = Number(value);
    return Number.isSafeInteger(normalized) ? normalized : null;
}

function isPlainDataObject(value) {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Collect legacy commands without requiring a whole function call to stay on one line.
 * @param {string} commandBlock
 * @returns {{ text: string, line: number }[]}
 */
function collectLegacyCommandEntries(commandBlock) {
    const lines = String(commandBlock ?? '').split(/\r?\n/u);
    /** @type {{ text: string, line: number }[]} */
    const entries = [];
    /** @type {{ text: string, line: number } | null} */
    let pending = null;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const trimmed = line.trim();

        if (!pending) {
            if (!trimmed) continue;
            if (!/^(?:insertRow|updateRow|deleteRow)\b/u.test(trimmed)) {
                entries.push({ text: trimmed, line: index + 1 });
                continue;
            }
            pending = { text: trimmed, line: index + 1 };
        } else {
            pending.text += `\n${line}`;
        }

        if (hasClosedLegacyCall(pending.text)) {
            entries.push(pending);
            pending = null;
        }
    }

    if (pending) entries.push(pending);
    return entries;
}

function hasClosedLegacyCall(commandText) {
    let inQuote = false;
    let quoteChar = '';
    let parenthesisDepth = 0;
    let sawOpeningParenthesis = false;

    for (let index = 0; index < commandText.length; index += 1) {
        const char = commandText[index];
        const escaped = isEscaped(commandText, index);

        if (inQuote) {
            if (char === quoteChar && !escaped) inQuote = false;
            continue;
        }

        const openingQuote = getOpeningQuote(char);
        if (openingQuote && !escaped) {
            inQuote = true;
            quoteChar = openingQuote.close;
            continue;
        }

        if (char === '(' || char === '\uFF08') {
            parenthesisDepth += 1;
            sawOpeningParenthesis = true;
        } else if ((char === ')' || char === '\uFF09') && sawOpeningParenthesis) {
            parenthesisDepth -= 1;
            if (parenthesisDepth <= 0) return true;
        }
    }

    return false;
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

    const commands = collectLegacyCommandEntries(commandBlock);
    if (commands.length === 0) return [];

    /** @type {Operation[]} */
    const ops = [];
    for (const command of commands) {
        const trimmed = command.text.trim();
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
 * Strict parser used by autonomous table filling.
 *
 * The historical parseToOperations() API intentionally collapses malformed
 * commands and a legitimate empty edit block to the same [] value.  That is
 * useful for passive chat parsing, but an autonomous fill runner must know
 * whether "no operations" was an explicit model decision or a parse failure
 * before it marks source messages as processed.
 *
 * @param {string} aiResponseText
 * @returns {{
 *   ok: boolean,
 *   empty: boolean,
 *   operations: Operation[],
 *   error: null | { code: string, message: string, line?: number }
 * }}
 */
export function parseToOperationsDetailed(aiResponseText) {
    const source = String(aiResponseText ?? '');
    const openTags = source.match(/<Amily2Edit>/gu) || [];
    const closeTags = source.match(/<\/Amily2Edit>/gu) || [];
    if (openTags.length !== 1 || closeTags.length !== 1) {
        return strictParseFailure(
            'TABLE_FILL_EDIT_BLOCK_COUNT',
            '响应必须包含且只能包含一对完整的 <Amily2Edit> 标签。',
        );
    }

    const blockPattern = /<Amily2Edit>([\s\S]*?)<\/Amily2Edit>/u;
    const match = blockPattern.exec(source);
    if (!match) {
        return strictParseFailure(
            'TABLE_FILL_EDIT_BLOCK_INCOMPLETE',
            '响应中的 <Amily2Edit> 标签未完整闭合。',
        );
    }

    const outside = `${source.slice(0, match.index)}${source.slice(match.index + match[0].length)}`;
    if (!isAllowedLegacyEditEnvelope(outside)) {
        return strictParseFailure(
            'TABLE_FILL_EDIT_BLOCK_OUTSIDE_CONTENT',
            '严格文本填表响应在 <Amily2Edit> 块外只能包含完整的 thinking/finish 兼容标签或 HTML 注释。',
        );
    }

    const block = match[1];
    if (!block.trim()) {
        return {
            ok: true,
            empty: true,
            operations: [],
            error: null,
        };
    }

    const commentBlock = extractCompleteCommentOnlyBlock(block);
    if (commentBlock.malformed) {
        return strictParseFailure(
            'TABLE_FILL_EDIT_BLOCK_MALFORMED_COMMENT',
            'Amily2Edit 中的 HTML 注释未完整闭合或包含非法嵌套。',
        );
    }
    const commandBlock = commentBlock.matched
        ? commentBlock.content.trim()
        : block.trim();
    if (commentBlock.matched && !commandBlock) {
        return {
            ok: true,
            empty: true,
            operations: [],
            error: null,
        };
    }
    if (!commentBlock.matched && /<!--|-->/u.test(commandBlock)) {
        return strictParseFailure(
            'TABLE_FILL_EDIT_BLOCK_MALFORMED_COMMENT',
            'Amily2Edit 中的 HTML 注释必须完整，且不能与裸文本混排。',
        );
    }

    const commands = collectLegacyCommandEntries(commandBlock);
    const operations = [];
    let unknownCommentLine = false;
    for (const command of commands) {
        const trimmed = command.text.trim();
        if (!trimmed) continue;
        if (!/^(?:insertRow|updateRow|deleteRow)\b/u.test(trimmed)) {
            if (commentBlock.matched) {
                if (isExplicitLegacyNoopLine(trimmed)) {
                    continue;
                }
                unknownCommentLine = true;
                continue;
            }
            return strictParseFailure(
                'TABLE_FILL_EDIT_BLOCK_UNKNOWN_LINE',
                `第 ${command.line} 行不是允许的表格操作。`,
                command.line,
            );
        }
        const parsed = parseFunctionCall(trimmed);
        if (!parsed) {
            return strictParseFailure(
                'TABLE_FILL_EDIT_BLOCK_MALFORMED_COMMAND',
                `第 ${command.line} 行开始的表格操作无法解析。`,
                command.line,
            );
        }
        const operation = _argsToOperation(parsed.name, parsed.args);
        if (!operation) {
            return strictParseFailure(
                'TABLE_FILL_EDIT_BLOCK_INVALID_ARGUMENTS',
                `第 ${command.line} 行开始的表格操作参数无效。`,
                command.line,
            );
        }
        operations.push(operation);
    }

    if (unknownCommentLine) {
        return strictParseFailure(
            'TABLE_FILL_EDIT_BLOCK_UNKNOWN_LINE',
            '包含表格操作的 HTML 注释中混入了未知文本。',
        );
    }
    if (operations.length === 0) {
        if (commentBlock.matched) {
            return {
                ok: true,
                empty: true,
                operations: [],
                error: null,
            };
        }
        return strictParseFailure(
            'TABLE_FILL_EDIT_BLOCK_NO_COMMANDS',
            '非空的 <Amily2Edit> 块没有包含可执行的表格操作。',
        );
    }
    return {
        ok: true,
        empty: false,
        operations,
        error: null,
    };
}

function isAllowedLegacyEditEnvelope(outside) {
    return /^\s*(?:(?:<(thinking|finish|finsh)>[\s\S]*?<\/\1>|<!--(?:(?!--)[\s\S])*-->)\s*)*$/u.test(outside);
}

function isExplicitLegacyNoopLine(line) {
    const source = String(line ?? '').trim();
    if (!source) return true;
    if (/^(?:\/\/|#)/u.test(source)) return true;

    const normalized = source.replace(/[。.!！]+$/gu, '').trim();
    return /^(?:无(?:可靠)?(?:的)?表格(?:更新|变更|修改)|无需(?:进行)?(?:表格)?(?:更新|变更|修改)|没有(?:可靠)?(?:的)?(?:表格)?(?:更新|变更|修改)|本轮(?:无需|无)(?:进行)?(?:表格)?(?:更新|变更|修改)|本轮保持原表|保持原表|(?:no|without)\s+(?:(?:reliable|table)\s+)*(?:changes?|updates?|modifications?)|no[\s-]?op|none)$/iu.test(normalized);
}

function extractCompleteCommentOnlyBlock(block) {
    const source = String(block ?? '');
    let cursor = 0;
    const bodies = [];
    let matched = false;

    while (cursor < source.length) {
        const whitespace = /^\s*/u.exec(source.slice(cursor))?.[0] || '';
        cursor += whitespace.length;
        if (cursor >= source.length) break;
        if (!source.startsWith('<!--', cursor)) {
            return {
                matched: false,
                malformed: matched || source.slice(cursor).includes('-->'),
                content: '',
            };
        }
        matched = true;
        const bodyStart = cursor + 4;
        const closeIndex = source.indexOf('-->', bodyStart);
        if (closeIndex < 0) {
            return { matched: false, malformed: true, content: '' };
        }
        const body = source.slice(bodyStart, closeIndex);
        // Nested openers and "--" are not well-formed HTML comment data.
        if (body.includes('<!--') || body.includes('--')) {
            return { matched: false, malformed: true, content: '' };
        }
        bodies.push(body);
        cursor = closeIndex + 3;
    }

    return {
        matched,
        malformed: false,
        content: bodies.join('\n'),
    };
}

function strictParseFailure(code, message, line) {
    return {
        ok: false,
        empty: false,
        operations: [],
        error: {
            code,
            message,
            ...(Number.isSafeInteger(line) ? { line } : {}),
        },
    };
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
