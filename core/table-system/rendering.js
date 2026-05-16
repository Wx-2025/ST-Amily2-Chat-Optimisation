/**
 * @file Markdown/CSV 渲染 —— 把 TableState 渲染为 prompt 可用的字符串。
 *
 * 纯函数：吃 state、吐字符串。不读 store、不写盘、不发事件。
 *
 * 历史来源：从 manager.js 抽出
 *   - convertTablesToCsvString               → tablesToCsv
 *   - convertSelectedTablesToCsvString       → tablesToCsvWithSelection
 *   - convertTablesToCsvStringForContentOnly → tablesToCsvContentOnly
 *   - checkTableRules (内部)                  → _checkTableRules (内部)
 *
 * manager.js 保留同名 export 作 wrapper（自动注入 getState()），所有外部调用点零改动。
 *
 * @typedef {import('./dto/Table.js').Table} Table
 * @typedef {import('./dto/Table.js').TableState} TableState
 */

/**
 * 检查表格规则违规，返回聚合警告字符串（多行）。
 * 行数超限 + 多列字符限制超限。
 * @param {Table} table
 * @returns {string}
 */
function _checkTableRules(table) {
    const warnings = [];

    // 行数限制
    if (table.rowLimitRule && table.rowLimitRule > 0 && table.rows.length > table.rowLimitRule) {
        warnings.push(`【当前（${table.name}）超出规定（${table.rowLimitRule}）行，请结合剧情缩减至（${table.rowLimitRule}）行以下，但切莫完全删除。】`);
    }

    // 多列字符限制
    const charLimitRules = table.charLimitRules || {};
    for (const colIndexStr in charLimitRules) {
        const colIndex = parseInt(colIndexStr, 10);
        const limit = charLimitRules[colIndex];
        if (limit > 0 && colIndex >= 0 && colIndex < table.headers.length) {
            const colName = table.headers[colIndex];
            const offendingRows = [];
            table.rows.forEach((row, rowIndex) => {
                if (table.rowStatuses && table.rowStatuses[rowIndex] === 'pending-deletion') return;
                const cellContent = row[colIndex] || '';
                if (cellContent.length > limit) offendingRows.push(rowIndex);
            });
            if (offendingRows.length > 0) {
                warnings.push(`【当前（${table.name}）第（${offendingRows.join('、')}）行（${colName}）列，字符超出规定（${limit}）字限制，请进行缩减。】`);
            }
        }
    }

    return warnings.join('\n');
}

/**
 * 把单个 table 的"内容主体"（含 simplify 处理 + warnings）写入到 fullString 末尾。
 * 提取自三个渲染函数中重复的内层逻辑。
 *
 * @param {Table} table
 * @param {string} tagName
 * @returns {string}
 */
function _renderTableBody(table, tagName) {
    let out = '';
    const activeRows = table.rows.filter((row, i) => !table.rowStatuses || table.rowStatuses[i] !== 'pending-deletion');

    if (activeRows.length === 0) {
        out += '（该表当前内容为空）\n';
    } else {
        const simplifyThreshold = table.simplifyRowThreshold || 0;
        let simplifiedCount = 0;

        table.rows.forEach((row, rowIndex) => {
            if (table.rowStatuses && table.rowStatuses[rowIndex] === 'pending-deletion') return;

            // 历史内容简化：前 N 行用 ---已锁定--- 占位
            if (simplifyThreshold > 0 && rowIndex < simplifyThreshold) {
                if (simplifiedCount === 0) {
                    const placeholderCells = row.map(() => '---已锁定---');
                    out += `| ${rowIndex} | ${placeholderCells.join(' | ')} |\n`;
                    out += `| ... | ${row.map(() => '...').join(' | ')} |\n`;
                }
                if (rowIndex === simplifyThreshold - 1) {
                    const placeholderCells = row.map(() => '---已锁定---');
                    out += `| ${rowIndex} | ${placeholderCells.join(' | ')} |\n`;
                }
                simplifiedCount++;
                return;
            }

            if (Array.isArray(row)) {
                const rowCells = row.map(cell => {
                    const cellContent = (cell === null || cell === undefined || cell === '') ? '未知' : String(cell);
                    return cellContent.replace(/\|/g, '｜');
                });
                out += `| ${rowIndex} | ${rowCells.join(' | ')} |\n`;
            }
        });

        if (simplifiedCount > 0) {
            out += `\n【系统提示】：表格前 ${simplifiedCount} 行（索引 0 到 ${simplifiedCount - 1}）的历史内容已简化并锁定，无需读取或修改。请专注于后续行的内容。\n`;
        }
    }

    return out;
}

/**
 * 完整渲染：所有表格内容 + 规则 + 警告，注入到主流程 prompt。
 * 对应 manager.js#convertTablesToCsvString。
 *
 * @param {TableState | null} state
 * @returns {string}
 */
export function tablesToCsv(state) {
    if (!state || state.length === 0) return '';

    let fullString = '';
    state.forEach((table, tableIndex) => {
        // 标题
        fullString += `\n* ${tableIndex}:${table.name}\n`;

        // 说明
        fullString += `【说明】:\n${table.note || '无'}\n`;

        // 内容（Markdown 表）
        const tagName = table.name.replace(/\s/g, '') + '内容';
        fullString += `<${tagName}>\n`;
        const headerWithIndex = ['rowIndex', ...table.headers.map((h, i) => `${i}:${h}`)];
        fullString += `| ${headerWithIndex.join(' | ')} |\n`;
        fullString += `|${headerWithIndex.map(() => '---').join('|')}|\n`;
        fullString += _renderTableBody(table, tagName);

        // 警告
        const warnings = _checkTableRules(table);
        if (warnings) fullString += `${warnings}\n`;
        fullString += `</${tagName}>\n`;

        // 规则
        fullString += `【增加】: ${table.rule_add || '允许'}\n`;
        fullString += `【删除】: ${table.rule_delete || '允许'}\n`;
        fullString += `【修改】: ${table.rule_update || '允许'}\n`;

        if (tableIndex < state.length - 1) fullString += '\n---\n';
    });

    return fullString;
}

/**
 * 选中态渲染：未选中的表格只展示表头作为索引参考；选中的展示完整内容。
 * 对应 manager.js#convertSelectedTablesToCsvString。
 *
 * @param {TableState | null} state
 * @param {number[]} selectedIndices
 * @returns {string}
 */
export function tablesToCsvWithSelection(state, selectedIndices) {
    if (!state || state.length === 0) return '';
    const selected = Array.isArray(selectedIndices) ? selectedIndices : [];

    let fullString = '';
    state.forEach((table, tableIndex) => {
        const isSelected = selected.includes(tableIndex);

        // 标题
        fullString += `\n* ${tableIndex}:${table.name}`;
        if (!isSelected) fullString += ' (本表格无需重新整理，仅供参考)';
        fullString += '\n';

        // 说明
        fullString += `【说明】:\n${table.note || '无'}\n`;

        const tagName = table.name.replace(/\s/g, '') + '内容';
        fullString += `<${tagName}>\n`;
        const headerWithIndex = ['rowIndex', ...table.headers.map((h, i) => `${i}:${h}`)];
        fullString += `| ${headerWithIndex.join(' | ')} |\n`;
        fullString += `|${headerWithIndex.map(() => '---').join('|')}|\n`;

        if (isSelected) {
            fullString += _renderTableBody(table, tagName);
            const warnings = _checkTableRules(table);
            if (warnings) fullString += `${warnings}\n`;
        } else {
            fullString += '（此处省略未选中的表格内容，仅提供表头供索引参考）\n';
        }
        fullString += `</${tagName}>\n`;

        // 规则
        if (isSelected) {
            fullString += `【增加】: ${table.rule_add || '允许'}\n`;
            fullString += `【删除】: ${table.rule_delete || '允许'}\n`;
            fullString += `【修改】: ${table.rule_update || '允许'}\n`;
        } else {
            fullString += `【操作权限】: 禁止修改此表格\n`;
        }

        if (tableIndex < state.length - 1) fullString += '\n---\n';
    });

    return fullString;
}

/**
 * 仅内容渲染：不带规则、不带 rowIndex 列、不带说明。
 * 用于"分步填表"和"优化中填表"模式下的 prompt 注入（只展示数据本身）。
 * 对应 manager.js#convertTablesToCsvStringForContentOnly。
 *
 * @param {TableState | null} state
 * @returns {string}
 */
export function tablesToCsvContentOnly(state) {
    if (!state || state.length === 0) return '';

    let outputString = '';
    state.forEach(table => {
        outputString += `\n<${table.name}>\n`;

        // Markdown 表头
        outputString += `| ${table.headers.join(' | ')} |\n`;
        outputString += `|${table.headers.map(() => '---').join('|')}|\n`;

        // 数据
        const activeRows = table.rows.filter((row, i) => !table.rowStatuses || table.rowStatuses[i] !== 'pending-deletion');
        if (activeRows.length > 0) {
            activeRows.forEach(row => {
                if (Array.isArray(row)) {
                    const rowContent = row.map(cell => (cell === null || cell === undefined || cell === '') ? ' ' : cell.toString());
                    outputString += `| ${rowContent.join(' | ')} |\n`;
                }
            });
        } else {
            outputString += '（该表当前内容为空）\n';
        }

        outputString += `</${table.name}>\n`;
    });

    return outputString.trim();
}
