export function generateIndex(data, headers, role, tableName = "") {
    if (!Array.isArray(data) || data.length === 0 || !Array.isArray(headers) || headers.length === 0) {
        return "";
    }

    const indexColumnIndices = identifyIndexColumns(data, headers);
    const indexColumnHeaders = indexColumnIndices.map(i => headers[i]);

    let indexLines = [];
    indexLines.push(`| ${indexColumnHeaders.join(' | ')} |`);
    indexLines.push(`| ${indexColumnHeaders.map(() => '---').join(' | ')} |`);

    let processedData = [...data];

    const firstColIndex = 0;
    const firstColHeader = headers[firstColIndex];
    const firstColVal = data[0] ? data[0][firstColIndex] : '';
    const isIndexCol = (firstColHeader && (firstColHeader.includes('索引') || firstColHeader.includes('Index'))) ||
                       (typeof firstColVal === 'string' && /^\s*M\d+/.test(firstColVal)) ||
                       (tableName && (tableName.includes('总结') || tableName.includes('大纲')));

    if (isIndexCol) {
        processedData.sort((a, b) => {
            const valA = String(a[firstColIndex] || '');
            const valB = String(b[firstColIndex] || '');
            return valA.localeCompare(valB, undefined, { numeric: true });
        });
    }

    for (const row of processedData) {
        const lineParts = indexColumnIndices.map(colIndex => {
            let val = row[colIndex];
            if (val === undefined || val === null) return "";
            val = String(val).trim();
            if (val.length > 15) val = val.substring(0, 12) + "...";
            return val;
        });
        indexLines.push(`| ${lineParts.join(' | ')} |`);
    }

    return indexLines.join('\n');
}

function identifyIndexColumns(data, headers) {
    if (headers.length <= 2) return headers.map((_, i) => i);

    const candidates = [];
    const maxColumns = 3;

    for (let i = 0; i < headers.length; i++) {
        if (candidates.length >= maxColumns) break;

        const header = headers[i];
        let totalLen = 0;
        let count = 0;
        for (const row of data) {
            if (row[i]) {
                totalLen += String(row[i]).length;
                count++;
            }
        }
        const avgLen = count > 0 ? totalLen / count : 0;

        const isLongText = avgLen > 20;
        const isBlacklisted = /desc|bio|detail|history|经历|描述|详情/i.test(header);

        if (!isLongText && !isBlacklisted) {
            candidates.push(i);
        }
    }

    if (candidates.length === 0) {
        return headers.map((_, i) => i).slice(0, Math.min(headers.length, maxColumns));
    }

    return candidates;
}
