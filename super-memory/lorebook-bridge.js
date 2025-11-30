import { amilyHelper } from "../tavern-helper/main.js";
import { extension_settings, getContext } from "/scripts/extensions.js";
import { extensionName } from "../../utils/settings.js";
import { this_chid, characters } from "/script.js";

function getMemoryBookName() {
    let charName = "Global";
    const context = getContext();
    
    if (this_chid !== undefined && characters[this_chid]) {
        charName = characters[this_chid].name;
    } else if (context.characterId !== undefined && characters[context.characterId]) {
        charName = characters[context.characterId].name;
    }
    
    const safeCharName = charName.replace(/[<>:"/\\|?*]/g, '_');
    return `Amily2_Memory_${safeCharName}`;
}

export async function syncToLorebook(tableName, data, indexText, role, headers, rowStatuses, depth = 100) {
    console.log(`[Amily2-Bridge] 开始同步表格: ${tableName} (Depth: ${depth})`);

    await ensureMemoryBook();

    const bookName = getMemoryBookName();

    let entries = await amilyHelper.getLorebookEntries(bookName);
    if (!entries) entries = [];

    const entriesToUpdate = [];
    const entriesToCreate = [];

    const processEntry = (comment, keys, content, type = 'selective', enabled = true) => {
        const existingEntry = entries.find(e => e.comment === comment);
        if (existingEntry) {
            existingEntry.content = content;
            existingEntry.key = keys;
            existingEntry.order = depth; 
            
            if (type === 'constant') {
                existingEntry.constant = true;
            } else {
                existingEntry.constant = false;
            }
            if (existingEntry.enabled !== undefined) {
                 existingEntry.enabled = enabled;
            } else {
                 existingEntry.disable = !enabled;
            }
            entriesToUpdate.push(existingEntry);
        } else {
            entriesToCreate.push({
                comment: comment,
                keys: keys, 
                content: content,
                type: type, 
                position: 1, 
                order: depth, 
                enabled: enabled 
            });
        }
    };

    if (role === 'database') {
        const indexKey = [`Amily_Index_${tableName}`];
        const indexComment = `[Amily2] Index for ${tableName}`;
        let indexContent = `【${tableName} 索引】\n${indexText.trim()}`;

        if (tableName.includes("大纲")) {
            indexContent += `\n<system_note>\n【Amily2-前瞻性预测指令】\n为了实现“提前一轮触发绿灯世界书”的高级记忆回流，请在生成本轮回复时，根据当前剧情走向，**大胆预测并自然提及**下一轮可能出现的索引编码。可自行增加一个标签并使用<!--到-->html注释掉该编码。这将激活系统的预加载机制，确保剧情发展的连贯性。\n</system_note>`;
        }

        processEntry(indexComment, indexKey, indexContent, 'constant');
    }

    data.forEach((row, index) => {
        if (!row || row.length === 0) return;
        
        const primaryVal = row[0]; 
        
        if (!primaryVal) return;

        const isPendingDeletion = rowStatuses && rowStatuses[index] === 'pending-deletion';
        const isEnabled = !isPendingDeletion;

        const triggerKeys = [primaryVal];
        const entryComment = `[Amily2] Detail: ${tableName} - ${primaryVal}`;
        
        let finalHeaders = headers;
        if (!finalHeaders || finalHeaders.length < row.length) {
            finalHeaders = [];
            for(let i=0; i<row.length; i++) {
                finalHeaders.push((headers && headers[i]) ? headers[i] : `Col_${i}`);
            }
        }

        const settings = extension_settings[extensionName] || {};
        const optimizationEnabled = settings.context_optimization_enabled !== false; 

        let entryContent;

        if (optimizationEnabled) {
            const primaryVal = row[0] || 'Unknown';
            entryContent = `【${tableName}档案: ${primaryVal}】\n`;
            for (let i = 0; i < row.length; i++) {
                const key = finalHeaders[i] || `Col_${i}`;
                const val = row[i] || '';
                entryContent += `- ${key}: ${val}\n`;
            }
        } else {
            let textContent = `【${tableName} 详情】\n`;
            for (let i = 0; i < row.length; i++) {
                const key = finalHeaders[i] || `Col_${i}`;
                const val = row[i] || '';
                textContent += `- ${key}: ${val}\n`;
            }
            entryContent = textContent.trim();
        }

        processEntry(entryComment, triggerKeys, entryContent.trim(), 'selective', isEnabled);
    });

    const entriesToDelete = [];
    const tablePrefix = `[Amily2] Detail: ${tableName} -`;
    
    const activeKeys = new Set();
    for(const row of data) {
        if(row && row[0]) activeKeys.add(row[0]);
    }

    for (const entry of entries) {
        if (entry.comment && entry.comment.startsWith(tablePrefix)) {
            const entryKey = entry.comment.substring(tablePrefix.length).trim();
            if (!activeKeys.has(entryKey)) {
                entriesToDelete.push(entry.uid);
            }
        }
    }

    if (entriesToDelete.length > 0) {
        console.log(`[Amily2-Bridge] 清理 ${entriesToDelete.length} 个废弃条目...`);
        await amilyHelper.deleteLorebookEntries(bookName, entriesToDelete);
    }

    if (entriesToUpdate.length > 0) {
        console.log(`[Amily2-Bridge] 更新 ${entriesToUpdate.length} 个条目...`);
        await amilyHelper.setLorebookEntries(bookName, entriesToUpdate);
    }
    
    if (entriesToCreate.length > 0) {
        console.log(`[Amily2-Bridge] 创建 ${entriesToCreate.length} 个新条目...`);
        await amilyHelper.createLorebookEntries(bookName, entriesToCreate);
    }
    console.log(`[Amily2-Bridge] 同步完成: ${tableName}`);
}

export async function ensureMemoryBook() {
    const bookName = getMemoryBookName();
    const books = await amilyHelper.getLorebooks();
    
    if (!books.includes(bookName)) {
        console.log(`[Amily2-Bridge] 创建角色专用世界书: ${bookName}`);
        await amilyHelper.createLorebook(bookName);
    }

    const settings = extension_settings[extensionName] || {};
    const shouldBind = settings.superMemory_autoBind === true;

    if (shouldBind && bookName.startsWith("Amily2_Memory_") && bookName !== "Amily2_Memory_Global") {
        console.log(`[Amily2-Bridge] 自动绑定世界书到当前角色...`);
        await amilyHelper.bindLorebookToCharacter(bookName);
    } else if (!shouldBind) {
        console.log(`[Amily2-Bridge] 跳过自动绑定 (设置已禁用)。请手动在世界书管理中激活: ${bookName}`);
    }
}

function createEntryTemplate() {
    return {
        uid: Date.now() + Math.floor(Math.random() * 1000),
        key: [],
        keysecondary: [],
        comment: "",
        content: "",
        constant: false,
        selective: true,
        order: 100,
        position: 1, 
        enabled: true
    };
}

export async function updateTransientHint(hint) {
    console.log('[Amily2-Bridge] 更新瞬时记忆提示...');
    await ensureMemoryBook();
    const bookName = getMemoryBookName();

    const comment = "[Amily2] Active Memory Hint";
    const content = hint ? `\n<system_note>\n【重要记忆回响】\n${hint}\n</system_note>\n` : "";
    const enabled = !!hint;

    let entries = await amilyHelper.getLorebookEntries(bookName);
    if (!entries) entries = [];

    const existingEntry = entries.find(e => e.comment === comment);

    if (existingEntry) {
        existingEntry.content = content;
        existingEntry.enabled = enabled;
        existingEntry.order = 0; 
        existingEntry.constant = true;
        
        await amilyHelper.setLorebookEntries(bookName, [existingEntry]);
    } else if (hint) {
        const newEntry = {
            comment: comment,
            keys: [],
            content: content,
            constant: true,
            selective: false,
            order: 0,
            position: 0, 
            enabled: true
        };
        await amilyHelper.createLorebookEntries(bookName, [newEntry]);
    }
    
    console.log(`[Amily2-Bridge] 瞬时记忆提示已${enabled ? '启用' : '清除'}。`);
}
