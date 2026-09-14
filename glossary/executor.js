import { callSybdAI } from '../core/api/SybdApi.js';
import { getDataBankAttachments, getDataBankAttachmentsForSource, getFileAttachment } from '/scripts/chats.js';
import { extensionName } from '../utils/settings.js';
import { getPresetPrompts, getMixedOrder } from '../PresetSettings/index.js';
import { generateRandomSeed } from '../core/api.js';
import { safeLorebookEntries, safeUpdateLorebookEntries, compatibleWriteToLorebook } from '../core/tavernhelper-compatibility.js';
import { loadWorldInfo, saveWorldInfo, createWorldInfoEntry } from "/scripts/world-info.js";
import { escapeHTML } from '../utils/utils.js';
import { bindGlossaryTranslations, glossaryHtml, glossaryMessage, reportGlossaryStatus, releaseGlossaryTranslations, setGlossaryButton } from './i18n.js';

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
        reportGlossaryStatus(updateStatusCallback, 'novel.noChapters', {}, 'error');
        throw new Error('没有可处理的章节。');
    }

    reportGlossaryStatus(updateStatusCallback, 'novel.starting');

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
                reportGlossaryStatus(updateStatusCallback, 'novel.contextLoaded', { batch: previousBatchIndex });
            } else {
                throw new Error(`无法找到衔接批次 ${previousBatchIndex} 的世界书条目，请从 1 开始处理。`);
            }
        }

        for (let i = processingState.currentIndex; i < recognizedChapters.length; i += batchSize) {
            if (processingState.isAborted) {
                reportGlossaryStatus(updateStatusCallback, 'novel.paused', { current: i, total: recognizedChapters.length });
                return 'paused';
            }
            processingState.currentIndex = i;

            const currentBatchNumber = i + 1;
            const batch = recognizedChapters.slice(i, i + batchSize);
            const progress = `(${currentBatchNumber}/${recognizedChapters.length})`;
            reportGlossaryStatus(updateStatusCallback, 'novel.processing', { batch: currentBatchNumber, progress });

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
            
            reportGlossaryStatus(updateStatusCallback, 'novel.batchCompleted', { batch: currentBatchNumber }, 'success');
            previousBatchAIResponse = aiContent;
        }

        reportGlossaryStatus(updateStatusCallback, 'novel.completed', {}, 'success');
        return 'success';
    } catch (error) {
        console.error('处理小说时发生严重错误:', error);
        reportGlossaryStatus(updateStatusCallback, 'novel.failed', { error: error.message }, 'error');
        throw error;
    }
}

export async function reorganizeEntriesByHeadings(bookName, headingsToProcess, updateStatusCallback) {
    try {
        reportGlossaryStatus(updateStatusCallback, 'tools.starting');
        const bookData = await loadWorldInfo(bookName);
        if (!bookData || !bookData.entries) {
            throw new Error(`无法加载世界书 "${bookName}" 的数据。`);
        }
        const allEntries = Object.values(bookData.entries);
        reportGlossaryStatus(updateStatusCallback, 'tools.parsing', { entries: allEntries.length, headings: headingsToProcess.length });

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
            reportGlossaryStatus(updateStatusCallback, 'tools.noMatches');
            return;
        }

        reportGlossaryStatus(updateStatusCallback, 'tools.merging', { count: foundHeadingsCount });

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

        reportGlossaryStatus(updateStatusCallback, 'tools.completed', { count: foundHeadingsCount }, 'success');
        toastr.success(escapeHTML(glossaryMessage('tools.saved', { book: bookName })));

    } catch (error) {
        console.error('重组世界书条目时发生错误:', error);
        reportGlossaryStatus(updateStatusCallback, 'tools.failed', { error: error.message }, 'error');
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
        toastr.error(glossaryMessage('database.readFailed'));
        return;
    }

    const container = document.getElementById('database-file-list-container');
    releaseGlossaryTranslations(container, { includeRoot: false });
    container.innerHTML = ''; 
    if (fileMap.size === 0) {
        container.innerHTML = `<small>${glossaryHtml('database.empty')}</small>`;
        bindGlossaryTranslations(container);
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
                setGlossaryButton(document.getElementById('select-from-database-button'), 'novel.selectedFile', { file: file.name }, 'fas fa-check');

            } catch (error) {
                console.error(`Error processing file ${file.name}:`, error);
                toastr.error(escapeHTML(glossaryMessage('database.fileFailed', { file: file.name })));
            }
        });
        container.appendChild(fileElement);
    });

    container.style.display = 'block';
}
