
'use strict';

const CHINESE_NUMBERS = {
    '零': 0, '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
    '十': 10, '百': 100, '千': 1000, '万': 10000, '亿': 100000000
};


function chineseToArabic(chineseStr) {
    if (!chineseStr) return 0;
    let total = 0;
    let section = 0;
    let unit = 1;
    for (let i = chineseStr.length - 1; i >= 0; i--) {
        const char = chineseStr[i];
        const num = CHINESE_NUMBERS[char];
        if (num >= 10) {
            if (num > unit) unit = num;
            else unit = unit * num;
        } else {
            section += num * unit;
        }
        if (unit >= 10000 || i === 0) {
            total += section;
            section = 0;
            unit = 1;
        }
    }
    if (chineseStr.startsWith('十') && total < 20) {
        total += 10;
    }
    return total;
}

function parseOrderString(str) {
    if (!str || typeof str !== 'string') return 0;
    const arabicMatch = str.match(/(\d+)/);
    if (arabicMatch) return parseInt(arabicMatch[1], 10);
    const chineseMatch = str.match(/第?([零一二三四五六七八九十百千万亿]+)[章卷节回部]/);
    if (chineseMatch) return chineseToArabic(chineseMatch[1]);
    return 0;
}


function getSortKey(result) {
    if (!result || !result.metadata) return null;

    const { metadata } = result;
    const part = metadata.part || 1;

    switch (metadata.source) {
        case 'chat_history':
            return [1, metadata.floor || 0, part]; 

        case 'novel':
            const vol = parseOrderString(metadata.volume || '');
            const chap = parseOrderString(metadata.chapter || '');
            const sec = parseOrderString(metadata.section || '');
            return [2, vol, chap, sec]; 

        case 'manual':
            const timestamp = new Date(metadata.timestamp || 0).getTime();
            return [3, timestamp, part]; 

        case 'lorebook':

            return [4, metadata.sourceName || '', part];

        default:
            return null;
    }
}


export function superSort(results) {
    if (!Array.isArray(results) || results.length === 0) {
        return [];
    }

    console.log('[翰林院-超级排序 v3.0] 开始执行精细规则排序...');

    const sortedResults = [...results].sort((a, b) => {
        const keyA = getSortKey(a);
        const keyB = getSortKey(b);

        const aHasKey = keyA !== null;
        const bHasKey = keyB !== null;

        if (aHasKey && !bHasKey) return -1;
        if (!aHasKey && bHasKey) return 1;

        if (!aHasKey || keyA[0] !== keyB[0]) {
            return (b.final_score || 0) - (a.final_score || 0);
        }


        for (let i = 1; i < keyA.length; i++) {
            const valA = keyA[i];
            const valB = keyB[i];

            if (typeof valA === 'string') {
                if (valA !== valB) {

                    return (b.final_score || 0) - (a.final_score || 0);
                }

                continue;
            }

            if (valA !== valB) {
                return (valA || 0) - (valB || 0);
            }
        }

        return 0; 
    });

    console.log('[翰林院-超级排序 v3.0] 精细规则排序完成。');
    return sortedResults;
}
