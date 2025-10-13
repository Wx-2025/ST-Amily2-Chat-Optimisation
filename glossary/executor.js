import { callSybdAI } from '../core/api/SybdApi.js';
import { getTargetWorldBook, syncNovelLorebookEntries } from '../CharacterWorldBook/src/cwb_lorebookManager.js';
import { getPresetPrompts, getMixedOrder } from '../PresetSettings/index.js';
import { generateRandomSeed } from '../core/api.js';

const { TavernHelper } = window;

function parseStructuredResponse(responseText) {
    const entries = [];
    const entryRegex = /【(.*?)】.*?\[START_TABLE\]([\s\S]*?)\[END_TABLE\]/g;
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


export async function executeNovelProcessing(recognizedChapters, batchSize, forceNew, updateStatusCallback) {
    if (recognizedChapters.length === 0) {
        updateStatusCallback('没有可处理的章节。', 'error');
        return;
    }

    updateStatusCallback('开始处理小说...', 'info');

    try {
        const bookName = await getTargetWorldBook();
        if (!bookName) throw new Error('无法确定目标世界书。');
        let existingEntriesContent = '当前世界书为空。';
        if (!forceNew) {
            const allEntries = (await TavernHelper.getLorebookEntries(bookName)) || [];
            const managedEntries = allEntries.filter(e => e.comment?.startsWith(`[Amily2小说处理]`));
            if (managedEntries.length > 0) {
                existingEntriesContent = managedEntries.map(entry => {
                    return `【${entry.keyword}】\n[START_TABLE]\n${entry.content}\n[END_TABLE]`;
                }).join('\n\n');
            }
        }

        for (let i = 0; i < recognizedChapters.length; i += batchSize) {
            const batch = recognizedChapters.slice(i, i + batchSize);
            const progress = `(${i + batch.length}/${recognizedChapters.length})`;
            updateStatusCallback(`正在处理批次 ${Math.floor(i / batchSize) + 1}... ${progress}`, 'info');

            const chapterContent = batch.map(c => `## ${c.title}\n${c.content}`).join('\n\n---\n\n');

            const order = getMixedOrder('novel_processor') || [];
            const presetPrompts = await getPresetPrompts('novel_processor');

            const messages = [
                { role: 'system', content: generateRandomSeed() }
            ];

            let promptCounter = 0;
            for (const item of order) {
                if (item.type === 'prompt') {
                    if (presetPrompts && presetPrompts[promptCounter]) {
                        messages.push(presetPrompts[promptCounter]);
                        promptCounter++;
                    }
                } else if (item.type === 'conditional') {
                    switch (item.id) {
                        case 'existingLore':
                            messages.push({ role: 'user', content: `# 已有世界书条目\n\n${existingEntriesContent}` });
                            break;
                        case 'chapterContent':
                            messages.push({ role: 'user', content: `# 最新章节内容\n\n${chapterContent}\n\n请根据以上信息，分析并输出需要新增或更新的世界书条目。` });
                            break;
                    }
                }
            }

            if (messages.length <= 1) { 
                throw new Error('未能根据预设构建有效的API请求。');
            }

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

            await syncNovelLorebookEntries(bookName, structuredData);
            existingEntriesContent = response;
        }

        updateStatusCallback('小说处理完成！', 'success');
    } catch (error) {
        console.error('处理小说时发生严重错误:', error);
        updateStatusCallback(`处理失败: ${error.message}`, 'error');
    }
}
