import { callSybdAI } from '../core/api/SybdApi.js';
import { getDataBankAttachments, getDataBankAttachmentsForSource, getFileAttachment } from '/scripts/chats.js';
import { extensionName } from '../utils/settings.js';
import { getPresetPrompts, getMixedOrder } from '../PresetSettings/index.js';
import { generateRandomSeed } from '../core/api.js';
import { safeLorebookEntries, safeUpdateLorebookEntries, compatibleWriteToLorebook } from '../core/tavernhelper-compatibility.js';
import { loadWorldInfo, saveWorldInfo, createWorldInfoEntry } from "/scripts/world-info.js";
import { escapeHTML } from '../utils/utils.js';

function buildContextFromEntries(entries) {
    if (!entries || entries.length === 0) {
        return '当前世界书为空。';
    }

    const mappedContent = entries.map(entry => {
        if (!Array.isArray(entry.keys) || entry.keys.length < 2) {
            return null;
        }
        const name = entry.keys[1];
        return `[--START_TABLE--]\n[name]:${name}\n${entry.content}\n[--END_TABLE--]`;
    }).filter(Boolean).join('\n\n');

    return mappedContent || '当前世界书为空。';
}

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
    const { chunks: recognizedChapters, batchSize, selectedWorldBook } = processingState;

    if (recognizedChapters.length === 0) {
        updateStatusCallback('没有可处理的章节。', 'error');
        throw new Error('没有可处理的章节。');
    }

    updateStatusCallback('开始处理小说...', 'info');

    try {
        const bookName = selectedWorldBook;
        if (!bookName) throw new Error('请先在设置中选择一个目标世界书。');

        let previousBatchAIResponse = '';

        if (processingState.currentIndex > 0) {
            const allEntries = (await safeLorebookEntries(bookName)) || [];
            const previousBatchIndex = processingState.currentIndex;
            const targetComment = `[Amily2小说处理] 链式生成-第${previousBatchIndex}部分`;
            const previousEntry = allEntries.find(e => e.comment === targetComment);

            if (previousEntry) {
                previousBatchAIResponse = previousEntry.content;
                updateStatusCallback(`已加载批次 ${previousBatchIndex} 的内容作为上下文。`, 'info');
            } else {
                throw new Error(`无法找到衔接批次 ${previousBatchIndex} 的世界书条目，请从 1 开始处理。`);
            }
        }

        for (let i = processingState.currentIndex; i < recognizedChapters.length; i += batchSize) {
            if (processingState.isAborted) {
                updateStatusCallback(`处理已中止。当前进度: ${i}/${recognizedChapters.length}`, 'info');
                return 'paused';
            }
            processingState.currentIndex = i;

            const currentBatchNumber = i + 1;
            const batch = recognizedChapters.slice(i, i + batchSize);
            const progress = `(${currentBatchNumber}/${recognizedChapters.length})`;
            updateStatusCallback(`正在处理批次 ${currentBatchNumber}... ${progress}`, 'info');

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
                        const contextContent = previousBatchAIResponse ? `# 上一章节的剧情发展概要\n\n${previousBatchAIResponse}` : '这是小说的第一部分，请开始生成剧情发展概要。';
                        messages.push({ role: 'user', content: contextContent });
                    } else if (item.id === 'chapterContent') {
                        messages.push({ role: 'user', content: `# 最新章节内容\n\n${chapterContent}\n\n请根据以上信息，分析并输出当前章节的剧情发展概要。` });
                    }
                }
            }

            if (messages.length <= 1) throw new Error('未能根据预设构建有效的API请求。');

            const response = await callSybdAI(messages);
            if (!response || response.trim().length === 0) {
                throw new Error(`API调用失败，批次 ${currentBatchNumber} 未收到有效响应。`);
            }
            
            const contentMatch = response.match(/\[--START_TABLE--\]([\s\S]*?)\[--END_TABLE--\]/);
            if (!contentMatch || !contentMatch[1]) {
                throw new Error(`API响应格式不正确，未找到被 '[--START_TABLE--]' 和 '[--END_TABLE--]' 包裹的内容，批次 ${currentBatchNumber}。`);
            }
            const aiContent = contentMatch[1].trim();
            
            const newEntryData = {
                comment: `[Amily2小说处理] 链式生成-第${currentBatchNumber}部分`,
                content: aiContent,
                keys: [`小说处理链式生成第${currentBatchNumber}部分`],
                enabled: true,
                order: 2000 + currentBatchNumber,
                position: 'before_char',
            };

            await compatibleWriteToLorebook(bookName, newEntryData.comment, () => newEntryData.content, {
                keys: newEntryData.keys,
                isConstant: false,
                insertion_position: newEntryData.position,
                order: newEntryData.order,
            });
            
            updateStatusCallback(`批次 ${currentBatchNumber} 处理完成，已创建新条目。`, 'success');
            previousBatchAIResponse = aiContent;
        }

        updateStatusCallback('小说处理完成！', 'success');
        return 'success';
    } catch (error) {
        console.error('处理小说时发生严重错误:', error);
        updateStatusCallback(`处理失败: ${error.message}`, 'error');
        throw error;
    }
}

export async function reorganizeEntriesByHeadings(bookName, headingsToProcess, updateStatusCallback) {
    try {
        updateStatusCallback('开始重组...', 'info');
        const bookData = await loadWorldInfo(bookName);
        if (!bookData || !bookData.entries) {
            throw new Error(`无法加载世界书 "${bookName}" 的数据。`);
        }
        const allEntries = Object.values(bookData.entries);
        updateStatusCallback(`已获取 ${allEntries.length} 个条目，正在根据您提供的 ${headingsToProcess.length} 个标题进行解析...`, 'info');

        const headingsMap = new Map();
        headingsToProcess.forEach(h => headingsMap.set(h, []));
        const finalEntries = {};
        const userTitlesSet = new Set(headingsToProcess);

        for (const entry of allEntries) {
            const lines = entry.content.split(/\r?\n/);
            let currentCaptureTitle = null;
            let currentCaptureContent = [];
            const remainingLines = [];

            const endCapture = () => {
                if (currentCaptureTitle && currentCaptureContent.length > 0) {
                    headingsMap.get(currentCaptureTitle).push(currentCaptureContent.join('\n'));
                }
                currentCaptureTitle = null;
                currentCaptureContent = [];
            };
            
            for (const line of lines) {
                const trimmedLine = line.trim();

                const isH1Title = trimmedLine.startsWith('#') && !trimmedLine.startsWith('##');

                if (isH1Title) {
                    endCapture(); 
                    
                    const potentialTitleFromFile = trimmedLine.substring(1).trim();
                    let matchedUserTitle = null;

                    for (const userTitle of userTitlesSet) {
                        if (potentialTitleFromFile.startsWith(userTitle)) {
                            matchedUserTitle = userTitle;
                            break;
                        }
                    }

                    if (matchedUserTitle) {
                        currentCaptureTitle = matchedUserTitle;
                    } else {
                        remainingLines.push(line);
                    }
                } else {
                    if (currentCaptureTitle) {
                        currentCaptureContent.push(line);
                    } else {
                        remainingLines.push(line);
                    }
                }
            }
            endCapture(); 

            const remainingContent = remainingLines.join('\n').trim();
            if (remainingContent) {
                finalEntries[entry.uid] = { ...entry, content: remainingContent };
            }
        }

        let foundHeadingsCount = 0;
        for (const contentBlocks of headingsMap.values()) {
            if (contentBlocks.length > 0) {
                foundHeadingsCount++;
            }
        }

        if (foundHeadingsCount === 0) {
            updateStatusCallback('在任何条目中都未找到您指定的标题，无需操作。', 'info');
            return;
        }

        updateStatusCallback(`解析完成，找到 ${foundHeadingsCount} 个匹配的标题类别。正在合并内容并创建新条目...`, 'info');

        for (const [title, contentBlocks] of headingsMap.entries()) {
            if (contentBlocks.length > 0) {
                const mergedContent = contentBlocks.map((block, index) => {
                    return `# ${title} - 第${index + 1}部分\n${block.trim()}`;
                }).join('\n\n');
                
                const newEntry = createWorldInfoEntry(bookName, bookData);
                Object.assign(newEntry, {
                    comment: `[Amily2重组] ${title}`,
                    content: mergedContent,
                    key: [title],
                    disable: false,
                    constant: false,
                    position: 0,
                    order: 2100,
                });
                finalEntries[newEntry.uid] = newEntry;
            }
        }
        
        bookData.entries = finalEntries;
        await saveWorldInfo(bookName, bookData, true);

        updateStatusCallback(`成功！已重组 ${foundHeadingsCount} 个标题。`, 'success');
        toastr.success(`世界书 "${bookName}" 已成功按标题重组。`);

    } catch (error) {
        console.error('重组世界书条目时发生错误:', error);
        updateStatusCallback(`错误: ${error.message}`, 'error');
        throw error;
    }
}

export async function loadDatabaseFiles() {
    const fileMap = new Map();
    try {
        getDataBankAttachments().forEach(file => {
            if (file && file.url) fileMap.set(file.url, file);
        });
        getDataBankAttachmentsForSource('global').forEach(file => {
            if (file && file.url) fileMap.set(file.url, file);
        });
        getDataBankAttachmentsForSource('character').forEach(file => {
            if (file && file.url) fileMap.set(file.url, file);
        });
        getDataBankAttachmentsForSource('chat').forEach(file => {
            if (file && file.url) fileMap.set(file.url, file);
        });
    } catch (error) {
        console.error('Error getting database files:', error);
        toastr.error('读取数据库文件失败。');
        return;
    }

    const container = document.getElementById('database-file-list-container');
    container.innerHTML = ''; 
    if (fileMap.size === 0) {
        container.innerHTML = '<small>未找到数据库文件。</small>';
        container.style.display = 'block';
        return;
    }

    const files = Array.from(fileMap.values());
    files.forEach(file => {
        const fileElement = document.createElement('div');
        fileElement.classList.add('database-file-item', 'menu_button', 'secondary', 'interactable');
        fileElement.textContent = file.name;
        fileElement.dataset.url = file.url;
        fileElement.addEventListener('click', async () => {
            try {
                const text = await getFileAttachment(file.url);

                console.log(`Loaded file content from ${file.name}`);

                const event = new CustomEvent('novel-file-loaded', { 
                    detail: { 
                        content: text,
                        fileName: file.name 
                    } 
                });
                document.dispatchEvent(event);

                container.style.display = 'none';
                document.getElementById('select-from-database-button').innerHTML = `<i class="fas fa-check"></i> 已选择: ${escapeHTML(file.name)}`;

            } catch (error) {
                console.error(`Error processing file ${file.name}:`, error);
                toastr.error(`处理文件 ${file.name} 失败。`);
            }
        });
        container.appendChild(fileElement);
    });

    container.style.display = 'block';
}
