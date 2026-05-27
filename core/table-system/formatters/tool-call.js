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
                                additionalProperties: { type: 'string' }
                            }
                        },
                        required: ['op', 'tableIndex']
                    }
                }
            },
            required: ['operations']
        }
    }
};

/**
 * 解析 tool_calls[0].function.arguments 字符串为 Operation[]。
 * 结构校验失败的单条操作会被静默跳过，不中断整体解析。
 *
 * @param {string} argsString - JSON 字符串
 * @returns {Operation[]}
 */
export function parseToolCallArgs(argsString) {
    let parsed;
    try {
        parsed = JSON.parse(argsString);
    } catch {
        return [];
    }

    const rawOps = parsed?.operations;
    if (!Array.isArray(rawOps)) return [];

    /** @type {Operation[]} */
    const ops = [];
    for (const raw of rawOps) {
        if (raw.op === 'insertRow' && Number.isInteger(raw.tableIndex) && raw.data && typeof raw.data === 'object') {
            ops.push({ op: 'insertRow', tableIndex: raw.tableIndex, data: raw.data });
        } else if (raw.op === 'updateRow' && Number.isInteger(raw.tableIndex) && Number.isInteger(raw.rowIndex) && raw.data && typeof raw.data === 'object') {
            ops.push({ op: 'updateRow', tableIndex: raw.tableIndex, rowIndex: raw.rowIndex, data: raw.data });
        } else if (raw.op === 'deleteRow' && Number.isInteger(raw.tableIndex) && Number.isInteger(raw.rowIndex)) {
            ops.push({ op: 'deleteRow', tableIndex: raw.tableIndex, rowIndex: raw.rowIndex });
        }
    }
    return ops;
}
