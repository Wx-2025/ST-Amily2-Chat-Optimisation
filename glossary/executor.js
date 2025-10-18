import { callSybdAI } from '../core/api/SybdApi.js';
import { extensionName } from '../utils/settings.js';
import { getPresetPrompts, getMixedOrder } from '../PresetSettings/index.js';
import { generateRandomSeed } from '../core/api.js';

const { TavernHelper } = window;

function parseStructuredResponse(responseText) {
    const entries = [];
    const entryRegex = /\[--START_TABLE--\]\s*\[name\]:(.*?)\n([\s\S]*?)\[--END_TABLE--\]/g;
    let match;

    while ((match = entryRegex.exec(responseText)) !== null) {
        const title = match[1].trim();
        const content = match[2].trim();
        if (title && content) {
            entries.push({ title, content });
        }
    }
    
    return entries;
}


export async function executeNovelProcessing(processingState, updateStatusCallback) {
    const { chunks: recognizedChapters, batchSize, forceNew, selectedWorldBook } = processingState;

    if (recognizedChapters.length === 0) {
        updateStatusCallback('没有可处理的章节。', 'error');
        throw new Error('没有可处理的章节。');
    }

    updateStatusCallback('开始处理小说...', 'info');

    try {
        const bookName = selectedWorldBook;
        if (!bookName) {
            throw new Error('请先在设置中选择一个目标世界书。');
        }

        const allEntries = (await TavernHelper.getLorebookEntries(bookName)) || [];
        const managedEntries = allEntries.filter(e => e.comment?.startsWith('[Amily2小说处理]') || e.comment?.startsWith('[Amily2-Glossary]'));

        let existingEntriesContent = '当前世界书为空。';
        if (!forceNew && managedEntries.length > 0) {
            existingEntriesContent = managedEntries.map(entry => {
                const name = entry.keyword;
                return `[--START_TABLE--]\n[name]:${name}\n${entry.content}\n[--END_TABLE--]`;
            }).join('\n\n');
        }

        for (let i = processingState.currentIndex; i < recognizedChapters.length; i += batchSize) {
            if (processingState.isAborted) {
                updateStatusCallback(`处理已中止。当前进度: ${i}/${recognizedChapters.length}`, 'info');
                return 'paused';
            }
            processingState.currentIndex = i;

            const batch = recognizedChapters.slice(i, i + batchSize);
            const progress = `(${i + batch.length}/${recognizedChapters.length})`;
            updateStatusCallback(`正在处理批次 ${Math.floor(i / batchSize) + 1}... ${progress}`, 'info');

            const chapterContent = batch.map(c => `## ${c.title}\n${c.content}`).join('\n\n---\n\n');
            const order = getMixedOrder('novel_processor') || [];
            const presetPrompts = await getPresetPrompts('novel_processor');
            const messages = [{ role: 'system', content: generateRandomSeed() }];

            let promptCounter = 0;
            for (const item of order) {
                if (item.type === 'prompt') {
                    if (presetPrompts && presetPrompts[promptCounter]) {
                        messages.push(presetPrompts[promptCounter]);
                        promptCounter++;
                    }
                } else if (item.type === 'conditional') {
                    if (item.id === 'existingLore') {
                        messages.push({ role: 'user', content: `# 已有世界书条目\n\n${existingEntriesContent}` });
                    } else if (item.id === 'chapterContent') {
                        messages.push({ role: 'user', content: `# 最新章节内容\n\n${chapterContent}\n\n请根据以上信息，分析并输出需要新增或更新的世界书条目。` });
                    }
                }
            }

            if (messages.length <= 1) throw new Error('未能根据预设构建有效的API请求。');

            const response = await callSybdAI(messages);
            if (!response || response.trim() === '无需更新') {
                updateStatusCallback(`批次 ${Math.floor(i / batchSize) + 1} 无需更新。`, 'info');
                continue;
            }

            const structuredData = parseStructuredResponse(response);
            if (structuredData.length === 0) {
                updateStatusCallback(`批次 ${Math.floor(i / batchSize) + 1} 未提取到有效信息。`, 'info');
                continue;
            }

            // --- 自定义同步逻辑 ---
            const currentAllEntries = (await TavernHelper.getLorebookEntries(bookName)) || [];
            const currentManagedEntries = currentAllEntries.filter(e => e.comment?.startsWith('[Amily2小说处理]') || e.comment?.startsWith('[Amily2-Glossary]'));
            
            const entriesToUpdate = [];
            const entriesToCreate = [];
            const fixedNovelEntries = ['世界观设定', '时间线', '角色关系网', '角色总览'];

            let maxPart = 0;
            currentManagedEntries.forEach(entry => {
                const match = entry.comment.match(/章节内容概述-第(\d+)部分/);
                if (match && parseInt(match[1], 10) > maxPart) maxPart = parseInt(match[1], 10);
            });
            let nextPart = maxPart + 1;

            for (const entry of structuredData) {
                const { title, content } = entry;
                let comment;
                let keys;

                if (title === '章节内容概述') {
                    comment = `[Amily2小说处理] ${title}-第${nextPart}部分`;
                    keys = [`小说处理`, title, `第${nextPart}部分`];
                    entriesToCreate.push({ keys, content, comment, enabled: true, order: 100, position: 'before_char' });
                    nextPart++;
                    continue;
                }

                const existingEntry = currentManagedEntries.find(e => e.keyword === title);
                
                if (fixedNovelEntries.includes(title)) {
                    comment = `[Amily2小说处理] ${title}`;
                    keys = [`小说处理`, title];
                } else {
                    comment = `[Amily2-Glossary] ${title}`;
                    keys = [`自定义条目`, title];
                }

                const loreData = { keys, content, comment, enabled: true, order: 100, position: 'before_char' };

                if (existingEntry) {
                    entriesToUpdate.push({ uid: existingEntry.uid, ...loreData });
                } else {
                    entriesToCreate.push(loreData);
                }
            }

            if (entriesToUpdate.length > 0) {
                await TavernHelper.setLorebookEntries(bookName, entriesToUpdate);
                updateStatusCallback(`更新了 ${entriesToUpdate.length} 个世界书条目。`, 'info');
            }
            if (entriesToCreate.length > 0) {
                await TavernHelper.createLorebookEntries(bookName, entriesToCreate);
                updateStatusCallback(`创建了 ${entriesToCreate.length} 个新世界书条目。`, 'success');
            }
            // --- 同步逻辑结束 ---

            existingEntriesContent = response; // 更新上下文以便下一个批次使用
        }

        updateStatusCallback('小说处理完成！', 'success');
        return 'success';
    } catch (error) {
        console.error('处理小说时发生严重错误:', error);
        updateStatusCallback(`处理失败: ${error.message}`, 'error');
        throw error;
    }
}
