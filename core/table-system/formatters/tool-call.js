/**
 * @file formatters/tool-call.js — Function Call 填表格式器
 *
 * 职责：
 *   - 导出 TABLE_FILL_TOOL：发给模型的 tools 定义（单工具 + operations 数组）
 *   - 导出 parseToolCallArgs：把 tool_calls[0].function.arguments 解析为 Operation[]
 *
 * 与 executor.js（legacy formatter）并列；下游 applyOperations 不感知来源。
 *
 * @typedef {import('../dto/Operation.js').Operation} Operation
 */

/**
 * Function Call 模式下覆盖旧版 <Amily2Edit> 文本协议。
 *
 * 批量/分步填表复用的规则模板仍包含 legacy 文本输出说明；若不显式覆盖，
 * 模型会同时收到“输出 JS 指令”和“调用工具”两套互斥要求。
 */
export const TABLE_FILL_TOOL_PROTOCOL_PROMPT = [
    '当前请求使用 Function Call 填表协议。',
    '忽略前文中关于输出 <Amily2Edit>、insertRow(...)、updateRow(...) 或 deleteRow(...) 文本的要求；这些仅适用于旧版文本模式。',
    '你必须且只能调用一次 apply_table_edits。',
    'function.arguments 必须是单个严格 JSON 对象，唯一顶层操作字段为 operations；禁止输出多个顶层对象、Markdown、注释或额外文本。',
    '每条 operation 必须完整满足工具 schema。确实无需修改时也必须显式返回 {"operations":[]}。',
].join('\n');

/**
 * 填表工具 schema。使用 operations 数组而非多工具并发，兼容所有支持 function calling 的提供商。
 *
 * data 的 key 为列索引字符串（"0"、"1"...），与 executor.js legacy 格式保持一致，
 * 提示词中会给出列索引与列名的对应关系。
 */
export const TABLE_FILL_TOOL = {
    type: 'function',
    function: {
        name: 'apply_table_edits',
        description: '将一批表格编辑操作应用到记忆表格中。',
        parameters: {
            type: 'object',
            properties: {
                operations: {
                    type: 'array',
                    description: '按顺序执行的操作列表。',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            op: {
                                type: 'string',
                                enum: ['insertRow', 'updateRow', 'deleteRow'],
                                description: 'insertRow=新增行，updateRow=更新已有行，deleteRow=删除行'
                            },
                            tableIndex: {
                                type: 'integer',
                                description: '目标表格的 0-based 索引'
                            },
                            rowIndex: {
                                type: 'integer',
                                description: 'updateRow / deleteRow 时必填，目标行的 0-based 索引'
                            },
                            data: {
                                type: 'object',
                                description: 'insertRow / updateRow 时必填，key 为列索引字符串（"0"/"1"...），value 为单元格内容',
                                minProperties: 1,
                                additionalProperties: { type: 'string' }
                            }
                        },
                        required: ['op', 'tableIndex']
                    }
                }
            },
            required: ['operations'],
            additionalProperties: false
        }
    }
};

function createToolArgsError(code, message) {
    const error = new Error(message);
    error.name = 'TableFillToolArgsError';
    error.code = `TABLE_FILL_TOOL_ARGS_${code}`;
    return error;
}

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidIndex(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function assertExactKeys(value, allowedKeys, label) {
    const keys = Object.keys(value).sort();
    const expected = [...allowedKeys].sort();
    if (
        keys.length !== expected.length
        || keys.some((key, index) => key !== expected[index])
    ) {
        throw createToolArgsError(
            'INVALID_OPERATION',
            `${label} 字段必须且只能是：${expected.join(', ')}。`,
        );
    }
}

function normalizeData(data, operationIndex) {
    if (!isRecord(data)) {
        throw createToolArgsError(
            'INVALID_OPERATION',
            `operations[${operationIndex}].data 必须是以列索引为 key 的对象。`,
        );
    }

    const entries = Object.entries(data);
    if (entries.length === 0) {
        throw createToolArgsError(
            'INVALID_OPERATION',
            `operations[${operationIndex}].data 至少需要包含一个单元格。`,
        );
    }

    const normalized = {};
    for (const [key, value] of entries) {
        if (!/^(0|[1-9]\d*)$/.test(key)) {
            throw createToolArgsError(
                'INVALID_OPERATION',
                `operations[${operationIndex}].data 包含非法列索引 "${key}"。`,
            );
        }
        if (typeof value !== 'string') {
            throw createToolArgsError(
                'INVALID_OPERATION',
                `operations[${operationIndex}].data["${key}"] 必须是字符串。`,
            );
        }
        normalized[key] = value;
    }
    return normalized;
}

/**
 * 解析 tool_calls[0].function.arguments 字符串为 Operation[]。
 *
 * 只有合法的 {"operations":[]} 会返回空数组。空响应、JSON 错误、
 * 根结构错误或任意一条非法 operation 都会抛错，防止调用方把失败误判为
 * “无需修改”并推进批次/写入已处理标记。
 *
 * @param {string} argsString - JSON 字符串
 * @returns {Operation[]}
 * @throws {Error} Function Call arguments 不是完整合法的填表对象
 */
export function parseToolCallArgs(argsString) {
    if (typeof argsString !== 'string' || !argsString.trim()) {
        throw createToolArgsError('EMPTY', 'Function Call 返回为空。');
    }

    let parsed;
    try {
        parsed = JSON.parse(argsString);
    } catch {
        throw createToolArgsError('INVALID_JSON', 'Function Call arguments 不是合法 JSON。');
    }

    if (!isRecord(parsed)) {
        throw createToolArgsError('INVALID_ROOT', 'Function Call arguments 顶层必须是 JSON 对象。');
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, 'operations')) {
        throw createToolArgsError('MISSING_OPERATIONS', 'Function Call arguments 缺少 operations 字段。');
    }
    const rootKeys = Object.keys(parsed);
    if (rootKeys.length !== 1 || rootKeys[0] !== 'operations') {
        throw createToolArgsError(
            'INVALID_ROOT',
            'Function Call arguments 顶层必须且只能包含 operations 字段。',
        );
    }

    const rawOps = parsed.operations;
    if (!Array.isArray(rawOps)) {
        throw createToolArgsError('INVALID_OPERATIONS', 'Function Call arguments.operations 必须是数组。');
    }

    /** @type {Operation[]} */
    const ops = [];
    for (let index = 0; index < rawOps.length; index++) {
        const raw = rawOps[index];
        if (!isRecord(raw)) {
            throw createToolArgsError('INVALID_OPERATION', `operations[${index}] 必须是对象。`);
        }
        if (!isValidIndex(raw.tableIndex)) {
            throw createToolArgsError(
                'INVALID_OPERATION',
                `operations[${index}].tableIndex 必须是非负安全整数。`,
            );
        }

        if (raw.op === 'insertRow') {
            assertExactKeys(raw, ['op', 'tableIndex', 'data'], `operations[${index}]`);
            ops.push({
                op: 'insertRow',
                tableIndex: raw.tableIndex,
                data: normalizeData(raw.data, index),
            });
            continue;
        }
        if (raw.op === 'updateRow') {
            if (!isValidIndex(raw.rowIndex)) {
                throw createToolArgsError(
                    'INVALID_OPERATION',
                    `operations[${index}].rowIndex 必须是非负安全整数。`,
                );
            }
            assertExactKeys(raw, ['op', 'tableIndex', 'rowIndex', 'data'], `operations[${index}]`);
            ops.push({
                op: 'updateRow',
                tableIndex: raw.tableIndex,
                rowIndex: raw.rowIndex,
                data: normalizeData(raw.data, index),
            });
            continue;
        }
        if (raw.op === 'deleteRow') {
            if (!isValidIndex(raw.rowIndex)) {
                throw createToolArgsError(
                    'INVALID_OPERATION',
                    `operations[${index}].rowIndex 必须是非负安全整数。`,
                );
            }
            assertExactKeys(raw, ['op', 'tableIndex', 'rowIndex'], `operations[${index}]`);
            ops.push({
                op: 'deleteRow',
                tableIndex: raw.tableIndex,
                rowIndex: raw.rowIndex,
            });
            continue;
        }

        throw createToolArgsError(
            'INVALID_OPERATION',
            `operations[${index}].op 不是受支持的填表操作。`,
        );
    }
    return ops;
}
