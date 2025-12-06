export function generateIndex(data, role, tableName = "") {
    if (!Array.isArray(data) || data.length === 0) {
        return "";
    }

    const headers = Object.keys(data[0]);
    if (headers.length === 0) return "";

    const indexColumns = identifyIndexColumns(data, headers);

    let indexLines = [];
    indexLines.push(`| ${indexColumns.join(' | ')} |`);
    indexLines.push(`| ${indexColumns.map(() => '---').join(' | ')} |`);

    let processedData = [...data];

    const firstColKey = headers[0];
    const firstColVal = data[0] ? data[0][firstColKey] : '';
    const isIndexCol = (firstColKey && (firstColKey.includes('索引') || firstColKey.includes('Index'))) ||
                       (typeof firstColVal === 'string' && /^\s*M\d+/.test(firstColVal)) ||
                       (tableName && (tableName.includes('总结') || tableName.includes('大纲')));

    if (isIndexCol) {
        processedData.sort((a, b) => {
            const valA = String(a[firstColKey] || '');
            const valB = String(b[firstColKey] || '');
            return valA.localeCompare(valB, undefined, { numeric: true });
        });
    }

    for (const row of processedData) {
        const lineParts = indexColumns.map(col => {
            let val = row[col];
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
    if (headers.length <= 2) return headers;

    const candidates = [];
    const maxColumns = 3;

    for (const header of headers) {
        if (candidates.length >= maxColumns) break;

        let totalLen = 0;
        let count = 0;
        for (const row of data) {
            if (row[header]) {
                totalLen += String(row[header]).length;
                count++;
            }
        }
        const avgLen = count > 0 ? totalLen / count : 0;

        const isLongText = avgLen > 20;
        const isBlacklisted = /desc|bio|detail|history|经历|描述|详情/i.test(header);

        if (!isLongText && !isBlacklisted) {
            candidates.push(header);
        }
    }

    if (candidates.length === 0) {
        return headers.slice(0, Math.min(headers.length, maxColumns));
    }

    return candidates;
}
