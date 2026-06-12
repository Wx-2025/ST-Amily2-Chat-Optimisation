'use strict';

import {
    extension_prompt_roles,
    setExtensionPrompt,
    eventSource,
    event_types,
    saveSettingsDebounced
} from '/script.js';
import { extension_settings } from '/scripts/extensions.js';

import * as ContextUtils from './utils/context-utils.js';
import { getCollectionIdInfo, getCharacterId, getCharacterStableId } from './utils/context-utils.js';
import { defaultSettings as ragDefaultSettings } from './rag-settings.js';
import { extractBlocksByTags, applyExclusionRules } from './utils/rag-tag-extractor.js';
import { resolveQueryPreprocessingRuleConfig } from '../utils/config/RuleProfileManager.js';
import { extensionName } from '../utils/settings.js';
import * as IngestionManager from './ingestion-manager.js'; 
import {
    getEmbeddings,
    fetchEmbeddingModels as apiFetchEmbeddingModels,
    fetchRerankModels as apiFetchRerankModels,
    executeRerank,
    testApiConnection as apiTestApiConnection
} from './rag-api.js';
import { superSort } from './super-sorter.js';
import { executeGraphRetrieval } from './relationship-graph/executor.js';
import { initializeArchiveManager } from './archive-manager.js';

const MODULE_NAME = 'hanlinyuan-rag-core';
const OFFICIAL_REARRANGE_CHAT_FUNCTION_NAME = 'vectors_rearrangeChat';
const GLOBAL_SCOPE_ID = '_global';



let context = null;
let settings = null;
let lockedCollectionId = null;

function filterWorldbooks(searchQuery, worldbooks) {
    if (!searchQuery || !searchQuery.trim()) {
        return worldbooks;
    }
    
    const query = searchQuery.toLowerCase().trim();
    
    return worldbooks.filter(bookName => {
        return bookName.toLowerCase().includes(query) ||
               containsPinyinMatch(bookName, query);
    });
}

function filterWorldbookEntries(searchQuery, entries) {
    if (!searchQuery || !searchQuery.trim()) {
        return entries;
    }
    
    const query = searchQuery.toLowerCase().trim();
    
    return entries.filter(entry => {
        const searchableText = [
            entry.comment || '',
            entry.key || '',
            entry.content || ''
        ].join(' ').toLowerCase();
        
        return searchableText.includes(query) ||
               containsPinyinMatch(entry.comment || '', query);
    });
}

function containsPinyinMatch(text, query) {
    const pinyinMap = {
        '世界书': 'sjshu',
        '条目': 'tiaomu', 
        '编纂': 'bianzhuan',
        '搜索': 'sousuo'
    };
    
    const pinyin = pinyinMap[text];
    return pinyin && pinyin.includes(query);
}


function highlightSearchMatch(text, query) {
    const safeText = String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    if (!query || !query.trim()) {
        return safeText;
    }
    const safeQuery = String(query)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const regex = new RegExp(`(${safeQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return safeText.replace(regex, '<mark class="search-highlight">$1</mark>');
}

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

export {
    initialize,
    getSettings,
    saveSettings,
    resetSettings,
    apiTestApiConnection as testApiConnection,
    apiFetchEmbeddingModels as fetchEmbeddingModels,
    apiFetchRerankModels as fetchRerankModels,
    getVectorCount,
    purgeStorage,
    getMessagesForCondensation,
    processCondensation,
    ingestTextToHanlinyuan,
    getCollectionId, 
    toggleSessionLock,
    isSessionLocked,
    getLockedSessionInfo,
    addKnowledgeBase,
    removeKnowledgeBase,
    getLocalKnowledgeBases,
    getGlobalKnowledgeBases,
    toggleKnowledgeBase,
    moveKnowledgeBase,
    filterWorldbooks,
    filterWorldbookEntries,
    highlightSearchMatch,
    debounce,
    renameKnowledgeBase,
};


function initialize() {
    context = SillyTavern.getContext();
    if (!context) {
        console.error('[翰林院] 未能获取SillyTavern上下文，初始化失败。');
        return;
    }
    migrateLegacyRagSettings();
    sanitizeProfilePollution();
    settings = getSettings();
    if (!window.hanlinyuanRagProcessor) {
        window.hanlinyuanRagProcessor = {};
    }
    
    window.hanlinyuanRagProcessor.rearrangeChat = rearrangeChat;
    window.hanlinyuanRagProcessor.initialized = true;
    eventSource.on(event_types.MESSAGE_RECEIVED, handleAutoCondensation);
    initializeArchiveManager();
    
    console.log('翰林院忆识核心已启动 (V5.3-归档版)，已注册到全局 hanlinyuanRagProcessor 对象。');
}


async function ingestTextToHanlinyuan(text, source = 'manual', metadata = {}, progressCallback = () => {}, signal = null, logCallback = () => {}, batchCompleteCallback = () => {}, jobId = null, resumeFromIndex = 0) {
    if (!text || !text.trim()) {
        return { success: false, error: '输入文本为空' };
    }
    if (!settings) return { success: false, error: '核心未初始化' };

    try {
        const idInfo = getCollectionIdInfo();
        const legacyCollectionId = await getDynamicCollectionId();
        if (idInfo.oldId && idInfo.oldId === legacyCollectionId && idInfo.oldId !== idInfo.newId) {
            const confirmMigration = confirm('检测到旧版数据。此操作将把旧数据迁移到新格式，过程不可逆，是否继续？');
            if (confirmMigration) {
                logCallback(`[翰林院-迁移] 用户确认迁移，正在处理旧宝库: ${idInfo.oldId}`, 'warn');
                await purgeStorage(idInfo.oldId); 
                logCallback(`[翰林院-迁移] 旧宝库已清空。`, 'success');
            } else {
                logCallback('[翰林院-迁移] 用户取消了迁移操作。', 'info');
                toastr.info('操作已取消。');
                return { success: false, error: '用户取消了迁移操作' };
            }
        }

        let kbName;
        let taskId;
        const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
        const charName = getCharacterName() || '未知角色';

        switch (source) {
            case 'chat_history':
                const range = metadata.range || {};
                const start = range.start ?? '?';
                const end = range.end === 0 ? '末' : (range.end ?? '?');
                kbName = `${charName}: ${start}楼-${end}楼`;
                break;
            case 'lorebook':
                const bookName = metadata.bookName || '未分类世界书';
                if (metadata.entryName && metadata.entryName.includes('微言录总结')) {
                    metadata.entryName = '对话记录小总结';
                } else if (metadata.entryName && metadata.entryName.includes('宏史卷总结')) {
                    metadata.entryName = '对话记录大总结';
                }
                const entryName = metadata.entryName || '未知条目';
                kbName = `${bookName}: ${entryName}`;
                break;
            case 'novel':
                kbName = `小说: ${metadata.sourceName || '未知小说'}`;
                break;
            case 'manual':
            default:
                kbName = `手动录入: ${timestamp}`;
                break;
        }

        // 独立聊天记忆模式：聊天记录类向量按聊天分桶（剧情线隔离），
        // 其余来源（小说/世界书/手动）属于"知识"，仍随角色卡共享
        const independentChatId = (source === 'chat_history' && settings.retrieval.independentChatMemoryEnabled)
            ? getChatId()
            : null;

        const existingKbs = Object.values(getKnowledgeBases());
        // 同名合并需限定在同一聊天命名空间内，避免独立模式下不同聊天的同名楼层段互相串库
        const foundKb = existingKbs.find(kb => kb.name === kbName && (kb.chatId ?? null) === independentChatId);

        if (foundKb) {
            taskId = foundKb.id;
            logCallback(`[翰林院-核心] 检测到同名知识库 "${kbName}"，将数据合并入库。`, 'info');
        } else {
            logCallback(`[翰林院-核心] 准备为任务 "${kbName}" 创建专属知识库...`, 'info');
            const newKb = addKnowledgeBase(kbName, source, independentChatId);
            taskId = newKb.id;
        }

        const charId = getCharacterStableId();
        const collectionId = independentChatId ? `${independentChatId}_${taskId}` : `${charId}_${taskId}`;
        logCallback(`[翰林院-核心] 已创建并锁定知识库: ${kbName} (集合ID: ${collectionId})`, 'success');
        logCallback(`[翰林院-核心] 已锁定忆识宝库ID: ${collectionId}`, 'info');

        progressCallback({ message: '正在智能分块...', processed: 0, total: 1 });
        const chunks = splitIntoChunks(text, source, metadata);
        const totalChunks = chunks.length;
        if (signal?.aborted) throw new Error('AbortError');
        logCallback(`[翰林院-核心] 将来源'${kbName}'的文本分割成 ${totalChunks} 个块。`, 'info');

        if (totalChunks === 0) {
            return { success: true, count: 0 };
        }

        const batchSize = settings.retrieval.batchSize || 5;
        let processedCount = resumeFromIndex; 

        for (let i = resumeFromIndex; i < totalChunks; i += batchSize) {
            if (signal?.aborted) throw new Error('AbortError');
            
            const batchChunks = chunks.slice(i, i + batchSize);
            
            progressCallback({ message: `正在处理 ${i + 1}-${i + batchChunks.length} 块`, processed: i, total: totalChunks });

            const batchTexts = batchChunks.map(c => c.text);
            const embeddings = await getEmbeddings(batchTexts, signal);
            if (signal?.aborted) throw new Error('AbortError');

            if (batchChunks.length !== embeddings.length) {
                throw new Error('文本块和向量数量不匹配');
            }

            const vectorItems = batchChunks.map((chunk, index) => ({
                ...chunk,
                vector: embeddings[index],
            }));

            await insertVectors(vectorItems, signal, collectionId);
            
            processedCount += batchChunks.length;

            if (jobId) {
                IngestionManager.saveProgress(jobId, processedCount, totalChunks);
            }
            
            await batchCompleteCallback();
        }

        if (jobId) {
            IngestionManager.clearJob(jobId);
        }


        logCallback(`[翰林院-核心] 成功插入 ${processedCount} 个向量条目。`, 'success');
        return { success: true, count: processedCount };

    } catch (error) {
        if (error.name === 'AbortError') {
            logCallback('[翰林院-核心] 文本录入任务被用户中止。', 'warn');
            throw error; 
        }
        console.error('[翰林院-核心] ingestTextToHanlinyuan 失败:', error);
        logCallback(`[翰林院-核心] 文本录入失败: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
}

function getSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    const root = extension_settings[extensionName];

    let s = root[MODULE_NAME];

    if (!s) {
        s = {};
        root[MODULE_NAME] = s;
    }

    if (s.condensationHistory === undefined) {
        s.condensationHistory = {};
    }

    if (s.knowledgeBases === undefined) {
        s.knowledgeBases = {};
    }

    if (s.queryPreprocessing === undefined) {
        s.queryPreprocessing = {
            enabled: false,
            tagExtractionEnabled: false,
            tags: 'content,details,摘要',
            exclusionRules: [],
        };
    }


    for (const key in ragDefaultSettings) {
        if (s[key] === undefined) {
            s[key] = structuredClone(ragDefaultSettings[key]);
        } else if (typeof ragDefaultSettings[key] === 'object' && !Array.isArray(ragDefaultSettings[key]) && ragDefaultSettings[key] !== null) {
            for (const subKey in ragDefaultSettings[key]) {
                if (s[key][subKey] === undefined) {
                    s[key][subKey] = ragDefaultSettings[key][subKey];
                }
            }
        }
    }

    // 旧版设置 rerank.priorityRetrieval 可能只有 enabled 字段而缺少 sources，补全
    if (s.rerank?.priorityRetrieval && !s.rerank.priorityRetrieval.sources) {
        s.rerank.priorityRetrieval.sources = structuredClone(ragDefaultSettings.rerank.priorityRetrieval.sources);
    }
    // 确保 sources 中每个来源条目完整（新增来源 / 新增字段时旧用户不会缺失）
    if (s.rerank?.priorityRetrieval?.sources) {
        const defaultSources = ragDefaultSettings.rerank.priorityRetrieval.sources;
        for (const sourceName in defaultSources) {
            if (!s.rerank.priorityRetrieval.sources[sourceName]) {
                s.rerank.priorityRetrieval.sources[sourceName] = structuredClone(defaultSources[sourceName]);
            } else {
                const existing = s.rerank.priorityRetrieval.sources[sourceName];
                for (const key in defaultSources[sourceName]) {
                    if (existing[key] === undefined) existing[key] = defaultSources[sourceName][key];
                }
            }
        }
    }

    return s;
}

function saveSettings() {
    saveSettingsDebounced();
}

function resetSettings() {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    extension_settings[extensionName][MODULE_NAME] = structuredClone(ragDefaultSettings);
    saveSettings();
}

function migrateLegacyRagSettings() {
    const legacy = extension_settings[MODULE_NAME];
    if (!legacy || typeof legacy !== 'object') return;

    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    const root = extension_settings[extensionName];

    // legacy 是用户此前实际交互过的真数据来源；nested 可能已被 super-memory 等模块用默认值填过，
    // 因此采用 legacy-优先的深合并：legacy 中的叶子值覆盖 nested，nested 中 legacy 没有的键保留。
    if (!root[MODULE_NAME] || typeof root[MODULE_NAME] !== 'object') {
        root[MODULE_NAME] = legacy;
        console.log(`[翰林院] 已迁移旧版 '${MODULE_NAME}' 设置到 extension_settings['${extensionName}']。`);
    } else {
        const merged = root[MODULE_NAME];
        const overlayLegacy = (src, dst) => {
            for (const key of Object.keys(src)) {
                const sv = src[key];
                if (sv && typeof sv === 'object' && !Array.isArray(sv) && dst[key] && typeof dst[key] === 'object' && !Array.isArray(dst[key])) {
                    overlayLegacy(sv, dst[key]);
                } else {
                    dst[key] = sv;
                }
            }
        };
        overlayLegacy(legacy, merged);
        console.log(`[翰林院] 发现新旧两处配置；已将顶层 '${MODULE_NAME}' 深合并覆盖到 extension_settings['${extensionName}']。`);
    }

    delete extension_settings[MODULE_NAME];
    saveSettingsDebounced();
}

/**
 * 一次性清洗 profile-sync 历史污染（2.2.5 之前的版本遗留）。
 *
 * 旧版 saveSettingsFromUI 会把被 Profile 接管的隐藏字段值写回 settings：
 *   - apiKey 被写成掩码 '••••••••'（rag-api 已有读侧防御，这里根治持久层）
 *   - apiEndpoint 的 select 被 _fillLegacyFields 赋了不存在的 option 值
 *     （profile.provider 如 'custom_oai'）后 value 变 ''，'' 被写回 settings；
 *     '' 在 getApiEndpointUrl 落 default 分支，请求被错误定向 → 向量化全失败
 *
 * 2.2.5 修复了"继续污染"，本函数清理已污染的存量数据。
 */
function sanitizeProfilePollution() {
    const s = getSettings();
    const MASKED = '••••••••';
    let cleaned = [];

    if (s.retrieval?.apiKey === MASKED) {
        s.retrieval.apiKey = '';
        cleaned.push('retrieval.apiKey 掩码');
    }
    if (s.rerank?.apiKey === MASKED) {
        s.rerank.apiKey = '';
        cleaned.push('rerank.apiKey 掩码');
    }

    // 合法值与 UI select 选项及 rag-api 的 switch 分支保持一致
    const validEndpoints = ['custom', 'google_direct', 'local_proxy', 'openai', 'azure'];
    if (s.retrieval && !validEndpoints.includes(s.retrieval.apiEndpoint)) {
        cleaned.push(`retrieval.apiEndpoint 非法值 "${s.retrieval.apiEndpoint}"`);
        s.retrieval.apiEndpoint = 'custom';
    }
    const validRerankModes = ['custom', 'local_proxy'];
    if (s.rerank && !validRerankModes.includes(s.rerank.apiMode)) {
        cleaned.push(`rerank.apiMode 非法值 "${s.rerank.apiMode}"`);
        s.rerank.apiMode = 'custom';
    }

    if (cleaned.length > 0) {
        console.warn(`[翰林院] 已清洗 profile-sync 历史污染字段: ${cleaned.join('、')}`);
        saveSettings();
    }
}

function showNotification(message, type = 'info') {
    toastr[type](message);
}


function getTagForSource(source) {
    switch (source) {
        case 'chat_history':
            return '聊天记录';
        case 'lorebook':
            return '世界书';
        case 'manual':
            return '手动录入';
        case 'novel':
            return '小说录入';
        default:
            return '资料';
    }
}


/**
 * 边界感知切分：把 content 切成不超过 chunkSize 的片段，尽量在自然边界断开。
 *
 * 三级回退策略（替代旧的纯字符硬切，避免句子/对话被拦腰截断）：
 *   1. 段落边界（最后一个换行符）
 *   2. 句末边界（。！？!?… 及其后跟随的闭合引号/括号）
 *   3. 都找不到（极端长串）才硬切
 * 边界切点过于靠前（< 40% 块长）时视为无效，降级到下一策略——防止
 * 一个超长段落开头的短句导致块碎片化。
 *
 * @param {string} content
 * @param {number} chunkSize - 单块最大字符数
 * @param {number} overlap   - 相邻块重叠字符数（语义衔接），从上一块尾部回看
 * @returns {string[]}
 */
function splitBySemanticBoundary(content, chunkSize, overlap) {
    const pieces = [];
    if (!content || chunkSize <= 0) return pieces;

    const minCut = Math.floor(chunkSize * 0.4);
    const sentenceEndRegex = /[。！？!?…][”"』」)）】]?/g;

    let pos = 0;
    while (pos < content.length) {
        let end = Math.min(pos + chunkSize, content.length);

        if (end < content.length) {
            const slice = content.substring(pos, end);

            // 1. 段落边界：最后一个换行（切点含换行符本身）
            let cut = slice.lastIndexOf('\n') + 1;

            // 2. 段落边界无效时找最后一个句末边界
            if (cut <= minCut) {
                let lastSentenceEnd = -1;
                sentenceEndRegex.lastIndex = 0;
                let m;
                while ((m = sentenceEndRegex.exec(slice)) !== null) {
                    lastSentenceEnd = m.index + m[0].length;
                }
                if (lastSentenceEnd > minCut) cut = lastSentenceEnd;
            }

            // 3. 有效边界则收缩切点，否则保持硬切
            if (cut > minCut) end = pos + cut;
        }

        const piece = content.substring(pos, end);
        if (piece.trim().length > 0) pieces.push(piece);

        if (end >= content.length) break;
        // overlap 回看；Math.max 防止 overlap >= 块长时死循环
        pos = Math.max(end - overlap, pos + 1);
    }
    return pieces;
}

/** 把 ISO/任意时间值格式化为写入块 prefix 的紧凑标识（不含逗号，便于正则反解） */
function formatChunkTimeLabel(timestamp) {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function splitIntoChunks(text, source, metadata = {}) {
    switch (source) {
        case 'novel':
            return _chunkForNovel(text, metadata);
        case 'chat_history':
            return _chunkForChatHistory(text, metadata);
        case 'lorebook':
            return _chunkForLorebook(text, metadata);
        case 'manual':
            return _chunkForManual(text, metadata);
        default:
            console.warn(`[翰林院-分块] 未知的来源类型 '${source}'，使用通用分块逻辑。`);
            return _chunkForManual(text, { ...metadata, sourceName: metadata.sourceName || '未知来源' });
    }
}

function _chunkForNovel(text, metadata) {
    const { chunkSize, overlap } = settings.advanced;
    const { sourceName = '小说' } = metadata;
    const allChunks = [];
    if (!text || chunkSize <= 0) return allChunks;

    const volumeRegex = /(第\s*[一二三四五六七八九十百千万零\d]+\s*卷)/gim;
    const chapterRegex = /(第\s*[一二三四五六七八九十百千万零\d]+\s*[章回节部])|^(Chapter\s+\d+)/gim;

    let globalChunkIndex = 0;
    const textLines = text.split('\n');
    let currentVolumeTitle = "第1卷";
    let currentChapterTitle = "第1章";
    let contentBuffer = [];

    function processBuffer() {
        if (contentBuffer.length === 0) return;
        const content = contentBuffer.join('\n');
        const tagName = getTagForSource('novel');
        splitBySemanticBoundary(content, chunkSize, overlap).forEach((chunkText, idx) => {
            const section = idx + 1;
            const chunkMetadata = {
                source: 'novel',
                sourceName: sourceName,
                timestamp: new Date().toISOString(),
                globalIndex: globalChunkIndex++,
                volume: currentVolumeTitle,
                chapter: currentChapterTitle,
                section: section,
            };
            const prefix = `[来源: ${sourceName}, ${currentVolumeTitle}, ${currentChapterTitle}, 第${section}节]`;
            const wrappedText = `<${tagName}>\n${prefix}\n${chunkText}\n</${tagName}>`;
            allChunks.push({ text: wrappedText, metadata: chunkMetadata });
        });
        contentBuffer = [];
    }

    for (const line of textLines) {
        const trimmedLine = line.trim();
        if (volumeRegex.test(trimmedLine)) {
            processBuffer();
            currentVolumeTitle = trimmedLine;
            currentChapterTitle = "第1章"; 
        } else if (chapterRegex.test(trimmedLine)) {
            processBuffer();
            currentChapterTitle = trimmedLine;
        } else {
            contentBuffer.push(line);
        }
    }
    processBuffer();

    if (allChunks.length === 0 && text.length > 0) {
        const tagName = getTagForSource('novel');
        splitBySemanticBoundary(text, chunkSize, overlap).forEach((chunkText, idx) => {
            const section = idx + 1;
            const chunkMetadata = {
                source: 'novel',
                sourceName: sourceName,
                timestamp: new Date().toISOString(),
                globalIndex: allChunks.length,
                volume: "第1卷",
                chapter: "第1章",
                section: section,
            };
            const prefix = `[来源: ${sourceName}, 第1卷, 第1章, 第${section}节]`;
            const wrappedText = `<${tagName}>\n${prefix}\n${chunkText}\n</${tagName}>`;
            allChunks.push({ text: wrappedText, metadata: chunkMetadata });
        });
    }
    return allChunks;
}


function _chunkForChatHistory(text, metadata) {
    const { chunkSize, overlap } = settings.advanced;
    const { floor, is_user, timestamp } = metadata;
    const allChunks = [];
    if (!text || chunkSize <= 0) return allChunks;

    // 时间写进 prefix 才能在检索后被反解回来（ST 向量存储不持久化 metadata）
    const timeLabel = formatChunkTimeLabel(timestamp);
    const tagName = getTagForSource('chat_history');

    splitBySemanticBoundary(text, chunkSize, overlap).forEach((chunkText, idx) => {
        const part = idx + 1;
        const prefix = timeLabel
            ? `[来源: 聊天记录, 楼层: #${floor}, 时间: ${timeLabel}, 第${part}部分]`
            : `[来源: 聊天记录, 楼层: #${floor}, 第${part}部分]`;
        const wrappedText = `<${tagName}>\n${prefix}\n${chunkText}\n</${tagName}>`;

        allChunks.push({
            text: wrappedText,
            metadata: {
                source: 'chat_history',
                sourceName: `聊天记录 #${floor}`,
                floor: floor,
                part: part,
                is_user: is_user,
                timestamp: timestamp,
            }
        });
    });
    return allChunks;
}


function _chunkForLorebook(text, metadata) {
    const { chunkSize, overlap } = settings.advanced;
    const { bookName = '世界书', entryName = '世界书条目' } = metadata;
    const allChunks = [];
    if (!text || chunkSize <= 0) return allChunks;

    const tagName = getTagForSource('lorebook');

    splitBySemanticBoundary(text, chunkSize, overlap).forEach((chunkText, idx) => {
        const part = idx + 1;
        const prefix = `[来源: ${bookName}, 条目: ${entryName}, 第${part}部分]`;
        const wrappedText = `<${tagName}>\n${prefix}\n${chunkText}\n</${tagName}>`;

        allChunks.push({
            text: wrappedText,
            metadata: {
                source: 'lorebook',
                sourceName: `${bookName}: ${entryName}`,
                bookName: bookName,
                entryName: entryName,
                part: part,
                timestamp: new Date().toISOString(),
            }
        });
    });
    return allChunks;
}


function _chunkForManual(text, metadata) {
    const { chunkSize, overlap } = settings.advanced;
    const { sourceName = '手动录入' } = metadata;
    const allChunks = [];
    if (!text || chunkSize <= 0) return allChunks;

    const timestamp = new Date();
    const readableTime = formatChunkTimeLabel(timestamp);
    const tagName = getTagForSource('manual');

    splitBySemanticBoundary(text, chunkSize, overlap).forEach((chunkText, idx) => {
        const part = idx + 1;
        const prefix = `[来源: ${sourceName}, 向量化录入时间: ${readableTime}, 第${part}部分]`;
        const wrappedText = `<${tagName}>\n${prefix}\n${chunkText}\n</${tagName}>`;

        allChunks.push({
            text: wrappedText,
            metadata: {
                source: 'manual',
                sourceName: sourceName,
                part: part,
                timestamp: timestamp.toISOString(),
            }
        });
    });
    return allChunks;
}

import { getCollectionId as getDynamicCollectionId, getCharacterName, getChatId } from './utils/context-utils.js';


async function getCollectionId() {
    if (lockedCollectionId) {
        return lockedCollectionId;
    }

    const independentMemoryEnabled = settings.retrieval.independentChatMemoryEnabled;

    if (independentMemoryEnabled) {
        return getChatId();
    } else {
        return await getDynamicCollectionId();
    }
}


async function toggleSessionLock() {
    if (lockedCollectionId) {
        lockedCollectionId = null;
        return false;
    } else {
        lockedCollectionId = await getDynamicCollectionId();
        return true;
    }
}


function isSessionLocked() {
    return lockedCollectionId !== null;
}


function getLockedSessionInfo() {
    if (!lockedCollectionId) return null;

    return {
        id: lockedCollectionId,
        name: `(已锁定: ${lockedCollectionId.substring(0, 8)}...)`
    };
}

function getLocalKnowledgeBases() {
    const charId = getCharacterStableId();
    if (!settings.knowledgeBases[charId]) {
        settings.knowledgeBases[charId] = {};
    }
    return settings.knowledgeBases[charId];
}

function getGlobalKnowledgeBases() {
    if (!settings.knowledgeBases[GLOBAL_SCOPE_ID]) {
        settings.knowledgeBases[GLOBAL_SCOPE_ID] = {};
    }
    return settings.knowledgeBases[GLOBAL_SCOPE_ID];
}

function getKnowledgeBases() {
    const localBases = getLocalKnowledgeBases();
    const globalBases = getGlobalKnowledgeBases();
    return { ...globalBases, ...localBases };
}

/**
 * @param {string} name
 * @param {string} source
 * @param {string|null} chatId - 非空时该库为"聊天级"：向量集合按 `${chatId}_${taskId}`
 *   命名空间隔离（独立聊天记忆模式下的聊天记录库），查询时只对该聊天可见
 */
function addKnowledgeBase(name, source = 'manual', chatId = null) {
    if (!name || !name.trim()) {
        throw new Error('知识库名称不能为空');
    }
    const charId = getCharacterStableId();
    const bases = getLocalKnowledgeBases();

    const taskId = `task_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const newBase = {
        id: taskId,
        name: name.trim(),
        enabled: true,
        createdAt: new Date().toISOString(),
        owner: charId,
        source: source,
        ...(chatId ? { chatId } : {}),
    };

    bases[taskId] = newBase;
    saveSettings();

    console.log(`[翰林院-核心] 已为角色 ${charId} 添加新知识库: ${name} (ID: ${taskId}${chatId ? `, 聊天级: ${chatId}` : ''})`);
    return newBase;
}

/**
 * 计算知识库的向量集合 ID（单一事实来源）。
 * 聊天级库（kb.chatId）按聊天命名空间，其余按 owner/角色命名空间。
 */
function getKbCollectionId(kb, scope = 'local') {
    if (kb.chatId) return `${kb.chatId}_${kb.id}`;
    if (scope === 'global') return `${kb.owner || GLOBAL_SCOPE_ID}_${kb.id}`;
    return `${getCharacterStableId()}_${kb.id}`;
}

async function removeKnowledgeBase(taskId, scope) {
    const charId = getCharacterStableId();
    const bases = scope === 'global' ? getGlobalKnowledgeBases() : getLocalKnowledgeBases();
    const base = bases[taskId];
    const baseName = base?.name || taskId;

    if (!base) {
        console.warn(`[翰林院-核心] 尝试删除一个不存在的知识库: ${taskId} (范围: ${scope})`);
        return;
    }

    const collectionIdToPurge = getKbCollectionId(base, scope);

    console.log(`[翰林院-核心] 准备删除知识库 ${taskId}，将清空集合: ${collectionIdToPurge}`);

    const purged = await purgeStorage(collectionIdToPurge);
    if (purged) {
        delete bases[taskId];
        saveSettings();
        console.log(`[翰林院-核心] 成功删除知识库 ${taskId} 及其向量数据。`);
        toastr.success(`知识库 "${baseName}" 已删除。`);
    } else {
        console.error(`[翰林院-核心] 清空向量集合 ${collectionIdToPurge} 失败，删除操作中止。`);
        toastr.error(`删除知识库失败，未能清空后端数据。`);
    }
}

function toggleKnowledgeBase(taskId, scope) {
    const bases = scope === 'global' ? getGlobalKnowledgeBases() : getLocalKnowledgeBases();
    if (bases[taskId]) {
        bases[taskId].enabled = !bases[taskId].enabled;
        saveSettings();
        console.log(`[翰林院-核心] 知识库 ${taskId} (范围: ${scope}) 的状态已切换为: ${bases[taskId].enabled ? '启用' : '禁用'}`);
    }
}

function generateHash(text) {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; 
    }
    return Math.abs(hash).toString(36);
}


async function queryVectors(queryText, options = {}) {
    const { includeBases = null } = options;
    let basesToQuery = [];

    console.log(`[翰林院-日志] 开始向量查询... (目标: ${includeBases ? '指定知识库' : '所有启用库'})`);

    if (includeBases) {
        basesToQuery = includeBases;
        console.log(`[翰林院-日志] 查询白名单已提供，将查询 ${basesToQuery.length} 个特定知识库。`);
    } 
    else if (settings.retrieval.independentChatMemoryEnabled) {
        console.log('[翰林院-日志] 独立聊天记忆模式开启...');

        const chatId = getChatId();
        if (!chatId) {
            console.warn('[翰林院-日志] 无法获取当前聊天ID，聊天级知识库将被跳过。');
        }

        // 本地库过滤规则：知识类库（无 chatId）照常可查；
        // 聊天级库（有 chatId）只对所属聊天可见——这就是"独立"的含义
        const localBases = Object.values(getLocalKnowledgeBases())
            .filter(b => b.enabled && (!b.chatId || b.chatId === chatId));
        if (localBases.length > 0) {
            const chatScoped = localBases.filter(b => b.chatId).length;
            console.log(`[翰林院-日志] 添加 ${localBases.length} 个本地知识库（其中 ${chatScoped} 个为当前聊天专属）。`);
            basesToQuery.push(...localBases.map(b => ({ ...b, scope: b.chatId ? 'chat' : 'local' })));
        }

        const enabledGlobalBases = Object.values(getGlobalKnowledgeBases()).filter(b => b.enabled);
        if (enabledGlobalBases.length > 0) {
            console.log(`[翰林院-日志] 添加 ${enabledGlobalBases.length} 个已启用的全局知识库。`);
            basesToQuery.push(...enabledGlobalBases.map(b => ({ ...b, scope: 'global' })));
        }
    }
    else {
        console.log('[翰林院-日志] 统一角色卡模式开启...');
        const localBases = getLocalKnowledgeBases();
        const globalBases = getGlobalKnowledgeBases();
        const enabledLocalBases = Object.values(localBases).filter(b => b.enabled);
        const enabledGlobalBases = Object.values(globalBases).filter(b => b.enabled);

        // 聊天级库（独立模式期间产生）在统一模式下也可见，但需用 'chat' scope
        // 才能拼出正确的集合 ID（${chatId}_${taskId}）
        basesToQuery.push(...enabledLocalBases.map(b => ({ ...b, scope: b.chatId ? 'chat' : 'local' })));
        basesToQuery.push(...enabledGlobalBases.map(b => ({ ...b, scope: 'global' })));

        if (basesToQuery.length === 0) {
            console.log('[翰林院-日志] 没有启用的新知识库，尝试查询旧版单体宝库...');
            const legacyCollectionId = await getDynamicCollectionId();
            if (legacyCollectionId) {
                basesToQuery.push({ id: null, name: '旧版宝库 (Legacy)', scope: 'legacy' });
            }
        }
    }

    if (basesToQuery.length === 0) {
        console.log('[翰林院-日志] 没有可供查询的知识库，查询中止。');
        return [];
    }

    const queryEmbedding = (await getEmbeddings([queryText]))[0];
    if (!queryEmbedding) {
        throw new Error("未能生成查询向量。");
    }
    
    const queryPromises = basesToQuery.map(base => _executeQueryForBase(base, queryText, queryEmbedding));

    const resultsFromAllBases = await Promise.all(queryPromises);
    let allResults = resultsFromAllBases.flat();

    console.log(`[翰林院-日志] 所有知识库查询完毕，共获得 ${allResults.length} 条初步结果。`);

    const uniqueResults = [];
    const seenTexts = new Set();
    
    for (const result of allResults) {
        if (result && typeof result === 'object' && result.text && typeof result.text === 'string') {
            const text = result.text.trim();
            if (text.length > 0 && !seenTexts.has(text)) {
                seenTexts.add(text);
                uniqueResults.push(result);
            }
        }
    }
    
    console.log(`[翰林院-日志] 去重后剩余 ${uniqueResults.length} 条结果。`);

    uniqueResults.sort((a, b) => (b.score || 0) - (a.score || 0));

    const finalResults = [...uniqueResults];
    
    console.log(`[翰林院-修复] 最终返回数组长度: ${finalResults.length}`);
    console.log(`[翰林院-修复] 最终返回数组样本:`, JSON.stringify(finalResults.slice(0, 1), null, 2));
    
    return finalResults;
}


async function _executeQueryForBase(base, queryText, queryEmbedding = null) {
    const charId = getCharacterStableId();
    let collectionId;

    switch (base.scope) {
        case 'legacy':
            collectionId = await getDynamicCollectionId();
            break;
        case 'chat':
            // 聊天级库：${chatId}_${taskId} 命名空间（独立聊天记忆）。
            // 旧语义的裸 chatId 集合从未被任何录入路径写入过，无存量兼容负担
            collectionId = base.chatId ? `${base.chatId}_${base.id}` : base.id;
            break;
        case 'global':
            const ownerId = base.owner || GLOBAL_SCOPE_ID;
            collectionId = `${ownerId}_${base.id}`;
            break;
        case 'local':
        default:
            collectionId = `${charId}_${base.id}`;
            break;
    }

    if (!collectionId) return [];

    console.log(`[翰林院-日志] 正在查询知识库: ${base.name} (ID: ${collectionId})`);

    const finalQueryEmbedding = queryEmbedding || (await getEmbeddings([queryText]))[0];
    if (!finalQueryEmbedding) {
        console.error(`[翰林院-日志] 未能为知识库 ${collectionId} 生成查询向量。`);
        return [];
    }

    const requestBody = {
        collectionId: collectionId,
        searchText: queryText,
        topK: settings.advanced.maxResults,
        threshold: settings.advanced.matchThreshold,
        source: 'webllm',
        embeddings: { [queryText]: finalQueryEmbedding }
    };

    try {
        const response = await fetch('/api/vector/query', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[翰林院-日志] 查询知识库 ${collectionId} 失败:`, errorText);
            return [];
        }
        const result = await response.json();
        
        let rawData = [];
        if (Array.isArray(result)) {
            rawData = result;
        } else if (result && result.metadata && Array.isArray(result.metadata)) {
            rawData = result.metadata;
        } else if (result && result.results && Array.isArray(result.results)) {
            rawData = result.results;
        } else if (result && result.data && Array.isArray(result.data)) {
            rawData = result.data;
        }

        const data = rawData.map(item => {
            if (!item || typeof item.text !== 'string') return null;

            const newMetadata = { source: 'unknown', sourceName: '未知' };
            const tagMatch = item.text.match(/^<([^>]+)>/);
            const sourceTag = tagMatch ? tagMatch[1] : '';

            switch (sourceTag) {
                case '聊天记录':
                    newMetadata.source = 'chat_history';
                    // 时间段为可选：兼容旧格式 [楼层: #X, 第Y部分] 与新格式 [楼层: #X, 时间: ..., 第Y部分]
                    const chatMatch = item.text.match(/楼层:\s*#(\d+)(?:,\s*时间:\s*([^,\]]+))?,\s*第(\d+)部分/);
                    if (chatMatch && chatMatch[1] && chatMatch[3]) {
                        newMetadata.floor = parseInt(chatMatch[1], 10);
                        if (chatMatch[2]) newMetadata.timeLabel = chatMatch[2].trim();
                        newMetadata.part = parseInt(chatMatch[3], 10);
                        newMetadata.sourceName = `聊天记录 #${newMetadata.floor}`;
                    }
                    break;
                case '世界书':
                    newMetadata.source = 'lorebook';
                    const loreMatch = item.text.match(/\[来源:\s*([^,]+),\s*条目:\s*([^,]+),\s*第(\d+)部分\]/);
                    if (loreMatch && loreMatch[1] && loreMatch[2] && loreMatch[3]) {
                        newMetadata.bookName = loreMatch[1].trim();
                        newMetadata.entryName = loreMatch[2].trim();
                        newMetadata.part = parseInt(loreMatch[3], 10);
                        newMetadata.sourceName = `${newMetadata.bookName}: ${newMetadata.entryName}`;
                    }
                    break;
                case '手动录入':
                    newMetadata.source = 'manual';
                    const manualMatch = item.text.match(/\[来源:\s*([^,]+),.*第(\d+)部分\]/);
                    if (manualMatch && manualMatch[1] && manualMatch[2]) {
                        newMetadata.sourceName = manualMatch[1].trim();
                        newMetadata.part = parseInt(manualMatch[2], 10);
                    }
                    break;
                case '小说录入':
                    newMetadata.source = 'novel';
                    const novelMatch = item.text.match(/\[来源:\s*([^,]+),\s*([^,]+),\s*([^,]+),\s*([^\]]+)\]/);
                    if (novelMatch) {
                        newMetadata.sourceName = novelMatch[1].trim();
                        newMetadata.volume = novelMatch[2].trim();
                        newMetadata.chapter = novelMatch[3].trim();
                        newMetadata.section = novelMatch[4].trim();
                    }
                    break;
            }
            
            return {
                ...item,
                score: item.score || 1.0, 
                metadata: newMetadata
            };
        }).filter(Boolean);

        console.log(`[翰林院-V13 修复] 重建元数据后，知识库 ${base.name} 返回 ${data.length} 条结果。`);
        return data;
    } catch (error) {
        console.error(`[翰林院-日志] 查询知识库 ${collectionId} 时发生网络错误:`, error);
        return [];
    }
}


async function insertVectors(vectorItems, signal = null, collectionId) {
    if (!collectionId) {
        throw new Error("insertVectors 必须接收一个有效的 collectionId 参数。");
    }

    if (vectorItems.length === 0) {
        return { success: true, count: 0 };
    }

    const items = vectorItems.map((item, index) => ({
        hash: generateHash(item.text + Date.now() + index),
        text: item.text,
        metadata: item.metadata || { source: 'unknown', timestamp: new Date().toISOString() },
    }));
    const embeddingsMap = items.reduce((acc, item, index) => {
        acc[item.text] = vectorItems[index].vector;
        return acc;
    }, {});

    const requestBody = {
        collectionId: collectionId,
        items: items,
        source: 'webllm',
        embeddings: embeddingsMap,
    };

    const response = await fetch('/api/vector/insert', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify(requestBody),
        signal: signal, 
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error('[翰林院-日志] 忆识存入API错误:', errorText);
        throw new Error(`忆识存入API错误 ${response.status}: ${errorText}`);
    }
    
    return { success: true, count: items.length };
}


async function getVectorCount(taskId = null, scope = 'local') {
    const charId = getCharacterStableId();
    
    if (taskId) {
        const bases = scope === 'global' ? getGlobalKnowledgeBases() : getLocalKnowledgeBases();
        const base = bases[taskId];
        if (!base) {
            console.warn(`[翰林院-计数] 在作用域 '${scope}' 中未找到ID为 ${taskId} 的知识库。`);
            return 0;
        }
        // 聊天级库按 ${chatId}_${taskId} 命名空间计数（getKbCollectionId 统一处理）
        return await countVectorsInCollection(getKbCollectionId(base, scope));

    } else {
        // 总数统计与查询侧保持同一可见性规则：
        //   独立模式 → 本地知识库 + 当前聊天的聊天级库 + 全局库
        //   统一模式 → 全部本地库（含聊天级）+ 全局库 + legacy 宝库
        const independent = settings.retrieval.independentChatMemoryEnabled;
        const chatId = independent ? getChatId() : null;
        console.log(`[翰林院-日志] 开始获取${independent ? '当前聊天可见的' : '所有'}知识库向量总数...`);

        const localBases = Object.values(getLocalKnowledgeBases())
            .filter(base => !independent || !base.chatId || base.chatId === chatId);
        const globalBases = Object.values(getGlobalKnowledgeBases());

        const countPromises = [];

        localBases.forEach(base => {
            countPromises.push(countVectorsInCollection(getKbCollectionId(base, 'local')));
        });

        globalBases.forEach(base => {
            countPromises.push(countVectorsInCollection(getKbCollectionId(base, 'global')));
        });

        if (!independent) {
            const legacyCollectionId = await getDynamicCollectionId();
            countPromises.push(countVectorsInCollection(legacyCollectionId));
        }

        const counts = await Promise.all(countPromises);
        const totalCount = counts.reduce((total, count) => total + count, 0);

        console.log(`[翰林院-日志] 知识库统计完成，总向量数: ${totalCount}`);
        return totalCount;
    }
}

async function countVectorsInCollection(collectionId) {
    if (!collectionId) return 0;
    console.log(`[翰林院-日志] 统计目标集合ID: ${collectionId}`);
    const requestBody = { collectionId, source: 'webllm', embeddings: {} };
    
    try {
        const response = await fetch('/api/vector/list', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            if (response.status === 404) {
                 console.log(`[翰林院-日志] 集合 ${collectionId} 不存在，计为 0。`);
            } else {
                const errorText = await response.text();
                console.warn(`[翰林院-日志] 获取集合 ${collectionId} 列表API时出现问题 (状态: ${response.status}):`, errorText);
            }
            return 0;
        }

        const result = await response.json();
        let count = 0;
        if (Array.isArray(result)) {
            count = result.length;
        } else if (result && result.hashes) {
            count = result.hashes.length;
        }
        return count;
    } catch (error) {
        console.error(`[翰林院-日志] 统计集合 ${collectionId} 时发生网络错误:`, error);
        return 0;
    }
}

async function purgeStorage(collectionIdOverride = null) {
    console.log('[翰林院-日志] 开始清空宝库...');
    const collectionId = collectionIdOverride || await getCollectionId();
    
    if (!collectionId) {
        console.error('[翰林院-日志] 无法确定要清空的目标集合ID。');
        toastr.error('无法确定要清空的目标宝库。');
        return false;
    }

    console.log(`[翰林院-日志] 清空目标集合ID: ${collectionId}`);

    const requestBody = { collectionId: collectionId };
    console.log('[翰林院-日志] 发送到 /api/vector/purge 的请求体:', JSON.stringify(requestBody, null, 2));

    const response = await fetch('/api/vector/purge', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify(requestBody),
    });

    console.log(`[翰林院-日志] /api/vector/purge 响应状态: ${response.status}`);
    if (!response.ok) {
        const errorText = await response.text();
        console.error('[翰林院-日志] 清空宝库API错误:', errorText);
    } else {
        console.log('[翰林院-日志] 清空宝库API调用成功。');
    }
    return response.ok;
}

function getMessagesForCondensation(overrideMessageTypes = null) {
    if (!settings.condensation.enabled) {
        showNotification('凝识之权未开启', 'warning');
        return [];
    }
    const { layerStart, layerEnd } = settings.condensation;
    const messageTypes = overrideMessageTypes || settings.condensation.messageTypes;
    const total = context.chat.length;
    const startIndex = Math.max(0, layerStart - 1);
    const endIndex = (layerEnd === 0 || layerEnd > total) ? total : Math.min(total, layerEnd);
    const messages = context.chat.slice(startIndex, endIndex);
    return messages.filter(msg => {
        const isUser = msg.is_user === true;
        const isAI = msg.is_user === false;
        if (!msg.mes || !msg.mes.trim()) {
            return false;
        }

        return (messageTypes.user && isUser) || (messageTypes.ai && isAI);
    });
}

async function processCondensation(messages, logCallback = () => {}, range = null, kbNameOverride = null) {
    if (!messages || messages.length === 0) {
        return { success: false, error: 'No messages to process.' };
    }

    try {
        let kbName;
        let taskId;
        const charName = getCharacterName() || '未知角色';

        if (kbNameOverride) {
            kbName = kbNameOverride;
        } else if (range) {
            const start = range.start ?? '?';
            const end = range.end === 0 ? '末' : (range.end ?? '?');
            kbName = `${charName}: ${start}楼-${end}楼`;
        } else {
            const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
            kbName = `聊天记录: ${timestamp}`;
        }

        // 独立聊天记忆模式下凝识结果按聊天分桶，与 ingestTextToHanlinyuan 的语义一致
        const independentChatId = settings.retrieval.independentChatMemoryEnabled ? getChatId() : null;

        const existingKbs = Object.values(getLocalKnowledgeBases());
        const foundKb = existingKbs.find(kb => kb.name === kbName && (kb.chatId ?? null) === independentChatId);

        if (foundKb) {
            taskId = foundKb.id;
            logCallback(`[翰林院-核心] 检测到同名知识库 "${kbName}"，将数据合并入库。`, 'info');
        } else {
            logCallback(`[翰林院-核心] 准备为任务 "${kbName}" 创建专属知识库...`, 'info');
            const newKb = addKnowledgeBase(kbName, 'chat_history', independentChatId);
            taskId = newKb.id;
        }

        const charId = getCharacterStableId();
        const collectionId = independentChatId ? `${independentChatId}_${taskId}` : `${charId}_${taskId}`;
        logCallback(`[翰林院-核心] 凝识任务已锁定知识库: ${kbName} (集合ID: ${collectionId})`, 'success');

        const allChunks = [];
        const fullChat = context.chat;

        for (const msg of messages) {
            const text = (msg.mes || '').replace(/<[^>]*>/g, '').trim();
            if (text.length === 0) continue;

            let floor;
            if (msg.floor !== undefined && msg.floor !== null) {
                floor = msg.floor;
            } else {
                const floorIndex = fullChat.findIndex(chatMsg => chatMsg === msg);
                floor = floorIndex !== -1 ? floorIndex + 1 : -1;
            }

            const sendDate = new Date(msg.send_date);
            const timestamp = isNaN(sendDate.getTime())
                ? new Date().toISOString()
                : sendDate.toISOString();

            const msgChunks = splitIntoChunks(text, 'chat_history', {
                floor: floor,
                is_user: msg.is_user,
                timestamp: timestamp,
            });
            allChunks.push(...msgChunks);
        }

        if (allChunks.length === 0) {
            return { success: true, count: 0 };
        }

        logCallback(`[翰林院-核心] 已将 ${messages.length} 条消息分解为 ${allChunks.length} 个知识块，准备入库。`, 'info');

        const batchSize = settings.retrieval.batchSize || 5;
        let processedCount = 0;

        for (let i = 0; i < allChunks.length; i += batchSize) {
            const batchChunks = allChunks.slice(i, i + batchSize);
            const batchTexts = batchChunks.map(c => c.text);
            const embeddings = await getEmbeddings(batchTexts);

            if (batchChunks.length !== embeddings.length) {
                throw new Error('文本块和向量数量不匹配');
            }

            const vectorItems = batchChunks.map((chunk, index) => ({
                ...chunk,
                vector: embeddings[index],
            }));

            await insertVectors(vectorItems, null, collectionId);
            processedCount += batchChunks.length;
        }

        if (range) {
            const finalEnd = range.end === 0 ? context.chat.length : range.end;
            const charId = getCharacterStableId();
            if (!settings.condensationHistory[charId]) {
                settings.condensationHistory[charId] = {};
            }
            settings.condensationHistory[charId][collectionId] = {
                start: range.start,
                end: finalEnd,
                timestamp: new Date().toISOString(),
            };
            saveSettings();
            logCallback(`[翰林院-核心] 已为宝库 ${collectionId} 记录凝识范围: ${range.start}-${finalEnd}`, 'info');
        }

        logCallback(`[翰林院-核心] 聊天记录凝识完成，成功插入 ${processedCount} 个条目。`, 'success');
        const successMessages = messages.map(msg => {
            const floorIndex = fullChat.findIndex(chatMsg => chatMsg === msg);
            const floor = floorIndex !== -1 ? floorIndex + 1 : -1;
            const author = msg.is_user ? '用户' : (getCharacterName() || 'AI');
            return `[${author} - 楼层 #${floor}] 的消息已成功凝识。`;
        });
        return { success: true, count: processedCount, messages: successMessages };

    } catch (error) {
        console.error('[翰林院-核心] processCondensation 失败:', error);
        logCallback(`[翰林院-核心] 聊天记录凝识失败: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
}

async function handleAutoCondensation() {
    if (!settings || !settings.condensation || !settings.condensation.enabled || !settings.condensation.autoCondense) {
        return;
    }

    setTimeout(async () => {
        try {
            const preserveFloors = settings.condensation.preserveFloors || 0;
            const totalMessages = context.chat.length;
            const chatId = getChatId(); // 获取当前聊天ID

            if (!chatId) {
                console.warn('[翰林院-自动凝识] 无法获取聊天ID，跳过。');
                return;
            }

            if (!settings.condensation.autoCondenseProgress) {
                settings.condensation.autoCondenseProgress = {};
            }

            const lastCondensedFloor = settings.condensation.autoCondenseProgress[chatId] || 0;
            
            const startFloor = lastCondensedFloor + 1;
            const endFloor = totalMessages - preserveFloors;
            
            if (startFloor > endFloor) {
                return;
            }
            
            const startIndex = startFloor - 1;
            const endIndex = endFloor; 
            
            const messagesToCondense = context.chat.slice(startIndex, endIndex);
            
            if (messagesToCondense.length === 0) return;
            
            console.log(`[翰林院-自动凝识] 触发自动凝识: ${startFloor} - ${endFloor} 楼 (ChatID: ${chatId})`);
            
            const BUCKET_SIZE = 100;
            let currentStart = startFloor;
            
            while (currentStart <= endFloor) {
                const bucketIndex = Math.floor((currentStart - 1) / BUCKET_SIZE);
                const bucketStartFloor = bucketIndex * BUCKET_SIZE + 1;
                const bucketEndFloor = (bucketIndex + 1) * BUCKET_SIZE;

                const currentEnd = Math.min(endFloor, bucketEndFloor);

                const sliceStart = currentStart - startFloor;
                const sliceEnd = currentEnd - startFloor + 1;
                const batchMessages = messagesToCondense.slice(sliceStart, sliceEnd);
                
                if (batchMessages.length > 0) {
                    const range = { start: currentStart, end: currentEnd };
                    const kbName = `${getCharacterName()}: 自动凝识 (${bucketStartFloor}-${bucketEndFloor})`;
                    
                    console.log(`[翰林院-自动凝识] 处理分桶: ${currentStart}-${currentEnd} -> ${kbName}`);
                    
                    const result = await processCondensation(batchMessages, (msg, type) => {
                        if (type === 'error') console.error(msg);
                        else console.log(msg);
                    }, range, kbName);

                    if (result.success) {
                        settings.condensation.autoCondenseProgress[chatId] = currentEnd;
                        saveSettings();
                    } else {
                        console.error(`[翰林院-自动凝识] 分桶 ${kbName} 处理失败，中止后续处理。`);
                        break;
                    }
                }

                currentStart = currentEnd + 1;
            }
            
        } catch (error) {
            console.error('[翰林院-自动凝识] 执行失败:', error);
        }
    }, 2000); // 延迟2秒
}

function preprocessQueryText(queryText) {
    if (!settings.queryPreprocessing.enabled) {
        return queryText;
    }

    let processedText = queryText;
    const { tagExtractionEnabled, tags, exclusionRules } = resolveQueryPreprocessingRuleConfig(settings);

    if (tagExtractionEnabled && tags) {
        const tagsToExtract = tags.split(',').map(t => t.trim()).filter(Boolean);
        if (tagsToExtract.length > 0) {
            const blocks = extractBlocksByTags(processedText, tagsToExtract);
            processedText = blocks.join('\n\n');
        }
    }

    if (exclusionRules && exclusionRules.length > 0) {
        processedText = applyExclusionRules(processedText, exclusionRules);
    }

    const trimmedResult = processedText.trim();

    if (queryText !== trimmedResult) {
        console.log(`[翰林院-预处理] 原始检索文本: "${queryText}"`);
        console.log(`[翰林院-预处理] 处理后检索文本: "${trimmedResult}"`);
    }
    
    return trimmedResult;
}


async function rerankResults(allResults, queryText, settings) {
    let processedResults = allResults;
    let rerankedSuccessfully = false;

    if (settings.rerank.enabled && allResults.length > 0) {
        console.log('[翰林院-Rerank] 开始外部API重排序...');
        try {
            const documentsToRerank = allResults.map(res => res.text);
            const rerankedData = await executeRerank(queryText, documentsToRerank, settings.rerank);
            const indexedResults = allResults.map((res, index) => ({ ...res, original_index: index }));
            
            processedResults = indexedResults.map(result => {
                const rerankedResult = rerankedData.results.find(r => r.index === result.original_index);
                const relevanceScore = rerankedResult ? rerankedResult.relevance_score : 0;
                return { ...result, rerank_score: relevanceScore };
            });

            rerankedSuccessfully = true;

        } catch (error) {
            console.error('[翰林院-Rerank] 外部Rerank失败，将仅使用内部加权。', error);
            if (settings.rerank.notify) showNotification(`Rerank失败: ${error.message}`, 'error');
            processedResults.forEach(res => res.rerank_score = 0);
        }
    } else {
        processedResults.forEach(res => res.rerank_score = 0);
    }

    console.log('[翰林院-Rerank] 开始元数据加权最终排序...');
    const totalMessages = context.chat.length;
    const alpha = settings.rerank.hybrid_alpha;

    const finalScoredResults = processedResults.map(result => {
        let contextualWeight = 1.0;
        const metadata = result.metadata || {};

        switch (metadata.source) {
            case 'lorebook': contextualWeight *= 1.2; break;
            case 'manual': contextualWeight *= 1.1; break;
            case 'chat_history':
                if (metadata.floor && totalMessages > 0) {
                    const recencyFactor = metadata.floor / totalMessages;
                    contextualWeight *= (1 + recencyFactor);
                }
                break;
        }

        const semanticScore = (result.rerank_score * alpha) + ((result.score || 0) * (1 - alpha));
        const finalScore = semanticScore * contextualWeight;

        return {
            text: result.text,
            score: result.score,
            rerank_score: result.rerank_score,
            final_score: finalScore,
            metadata: result.metadata,
        };
    });

    finalScoredResults.sort((a, b) => (b.final_score || 0) - (a.final_score || 0));
    console.log('[翰林院-Rerank] 元数据加权排序完成。');

    // 先按相关度截断 top_n，再做时序排序——顺序反了会让"时序最早"而非"最相关"
    // 的块占据名额（超级排序把最旧楼层排最前，slice 会扔掉高相关的靠后结果）
    let finalResults = finalScoredResults.slice(0, settings.rerank.top_n);
    if (settings.rerank.superSortEnabled) {
        finalResults = superSort(finalResults);
    }

    return {
        results: finalResults,
        reranked: rerankedSuccessfully
    };
}


/**
 * 从"第十二章"/"第3卷"/"4"等字符串中解析序数，用于注入前的时序排序。
 * 支持阿拉伯数字与常见中文数字（至万级）；解析失败返回 MAX_SAFE_INTEGER（排最后）。
 */
function _parseOrdinal(value) {
    if (typeof value === 'number') return value;
    if (!value) return Number.MAX_SAFE_INTEGER;
    const str = String(value);
    const arabic = str.match(/\d+/);
    if (arabic) return parseInt(arabic[0], 10);

    const cnDigit = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    const m = str.match(/[零一二两三四五六七八九十百千万]+/);
    if (!m) return Number.MAX_SAFE_INTEGER;
    let total = 0, current = 0;
    for (const ch of m[0]) {
        if (cnDigit[ch] !== undefined) {
            current = cnDigit[ch];
        } else if (ch === '十') {
            total += (current || 1) * 10;
            current = 0;
        } else if (ch === '百') {
            total += (current || 1) * 100;
            current = 0;
        } else if (ch === '千') {
            total += (current || 1) * 1000;
            current = 0;
        } else if (ch === '万') {
            total = (total + current) * 10000;
            current = 0;
        }
    }
    return total + current;
}

/**
 * 注入前的组内时序重排 + 断层提示。
 *
 * rerank/相似度负责"选哪些块"，本函数负责"按什么顺序呈现"：
 *   - chat_history 按楼层+部分升序；相邻块楼层跳跃时插入断层提示行，
 *     避免 LLM 把"不打不相识"和"关系亲密"两个远隔的片段读成连续剧情
 *   - novel 按卷/章/节序数升序（中文数字章节号可解析）
 *   - lorebook / manual 按来源聚合 + part 升序，碎块归位
 * 元数据缺失的块排在末尾、保持彼此原有顺序（sort 稳定性）。
 */
function _composeInjectionText(source, results) {
    const sorted = [...results];
    const ord = (v) => (Number.isFinite(v) ? v : Number.MAX_SAFE_INTEGER);

    if (source === 'chat_history') {
        sorted.sort((a, b) =>
            ord(a.metadata?.floor) - ord(b.metadata?.floor)
            || (a.metadata?.part ?? 0) - (b.metadata?.part ?? 0));

        const parts = [];
        let prevFloor = null;
        for (const r of sorted) {
            const floor = r.metadata?.floor;
            if (prevFloor !== null && Number.isFinite(floor) && floor - prevFloor > 1) {
                parts.push(`〔提示：以下内容与上文相隔约 ${floor - prevFloor} 楼，期间的剧情未被检索到，两段内容并非连续发生〕`);
            }
            parts.push(r.text);
            if (Number.isFinite(floor)) prevFloor = floor;
        }
        return parts.join('\n\n');
    }

    if (source === 'novel') {
        sorted.sort((a, b) =>
            _parseOrdinal(a.metadata?.volume) - _parseOrdinal(b.metadata?.volume)
            || _parseOrdinal(a.metadata?.chapter) - _parseOrdinal(b.metadata?.chapter)
            || _parseOrdinal(a.metadata?.section) - _parseOrdinal(b.metadata?.section));
        return sorted.map(r => r.text).join('\n\n');
    }

    // lorebook / manual：同源聚合 + part 升序
    sorted.sort((a, b) =>
        String(a.metadata?.sourceName ?? '').localeCompare(String(b.metadata?.sourceName ?? ''), 'zh')
        || (a.metadata?.part ?? 0) - (b.metadata?.part ?? 0));
    return sorted.map(r => r.text).join('\n\n');
}

async function rearrangeChat(chat, contextSize, abort, type) {
    const injectionKeys = {
        novel: 'HANLINYUAN_RAG_NOVEL',
        chat_history: 'HANLINYUAN_RAG_CHAT',
        lorebook: 'HANLINYUAN_RAG_LOREBOOK',
        manual: 'HANLINYUAN_RAG_MANUAL',
        graph: 'HANLINYUAN_RAG_GRAPH', // 新增图谱注入键
    };
    Object.values(injectionKeys).forEach(key => setExtensionPrompt(key, '', 0, 0, false, 0));

    if (type === 'quiet' || !settings.retrieval.enabled) return;

    const queryMessages = chat.slice(-settings.advanced.queryMessageCount);
    if (queryMessages.length === 0) return;
    
    const queryPreprocessingSettings = resolveQueryPreprocessingRuleConfig(settings);
    let queryText = '';
    const relevantTexts = [];

    for (const msg of queryMessages) {
        if (msg.is_user) {
            relevantTexts.push(msg.mes);
            continue;
        }

        if (queryPreprocessingSettings.enabled && queryPreprocessingSettings.tagExtractionEnabled) {
            const tagsToExtract = (queryPreprocessingSettings.tags || '').split(',').map(t => t.trim()).filter(Boolean);
            if (tagsToExtract.length > 0) {
                const blocks = extractBlocksByTags(msg.mes, tagsToExtract);
                if (blocks.length > 0) {
                    const innerContents = blocks.map(block => {
                        const match = block.match(/<[^>]+>([\s\S]*?)<\/[^>]+>/);
                        return match ? match[1].trim() : '';
                    });
                    relevantTexts.push(innerContents.filter(Boolean).join('\n\n'));
                }
            } else {
                relevantTexts.push(msg.mes); 
            }
        } else {
            relevantTexts.push(msg.mes);
        }
    }
    
    queryText = relevantTexts.filter(Boolean).join('\n\n');

    if (queryPreprocessingSettings.enabled) {
        queryText = applyExclusionRules(queryText, queryPreprocessingSettings.exclusionRules);
    }

    queryText = queryText.trim();

    if (!queryText) {
        console.log('[翰林院] 经过预处理后，最终检索文本为空，注入中止。');
        return;
    }

    const indexMatches = queryText.match(/(M\d+)/g);
    if (indexMatches) {
        const uniqueIndices = [...new Set(indexMatches)];
        const indexQuery = uniqueIndices.map(idx => `[索引: ${idx}]`).join(' ');
        queryText += `\n\n${indexQuery}`;
        console.log(`[翰林院] 检测到索引引用，已增强检索词: ${indexQuery}`);
    }

    console.log(`[翰林院-预处理] 最终用于检索的文本: "${queryText}"`);

    try {
        const graphContext = await executeGraphRetrieval(queryText);
        if (graphContext) {
            console.log('[翰林院] 成功获取关系图谱上下文，准备注入。');
            setExtensionPrompt(
                injectionKeys.graph,
                graphContext,
                settings.injection_lorebook ? settings.injection_lorebook.position : 0, // 复用世界书的注入位置
                settings.injection_lorebook ? settings.injection_lorebook.depth : 4,   // 复用世界书的深度
                false,
                0
            );
        }

        const SETTINGS_VERSION = 2; 
        const currentVersion = settings.settingsVersion || 1;
        let settingsModified = false;

        if (currentVersion < SETTINGS_VERSION) {
            console.log(`[翰林院-户口普查] 检测到旧版设置 (V${currentVersion})，开始强制重分类所有知识库...`);
            toastr.info('检测到旧版数据，正在进行一次性户口普查...', '翰林院通告');
            
            const allBasesObject = getKnowledgeBases();
            for (const kb of Object.values(allBasesObject)) {
                const name = kb.name;
                const oldSource = kb.source;
                
                if (name.startsWith('手动录入: ')) {
                    kb.source = 'manual';
                } else if (name.startsWith('小说:')) {
                    kb.source = 'novel';
                } else if (name.includes('楼-') && name.includes('楼') && name.includes(':')) {
                    kb.source = 'chat_history';
                } else {
                    kb.source = 'lorebook';
                }

                if (oldSource !== kb.source) {
                    console.log(`[翰林院-户口普查] 知识库 "${name}" 已从 [${oldSource || '无'}] 更正为 [${kb.source}]`);
                }
            }
            
            settings.settingsVersion = SETTINGS_VERSION;
            settingsModified = true;
        }

        if (settingsModified) {
            console.log('[翰林院-户口普查] 普查完成，正在保存更新后的户籍...');
            saveSettings();
        }


        let finalResults = [];
        const prioritySettings = settings.rerank.priorityRetrieval;

        if (prioritySettings.enabled) {
            // =================== 多路并行独立检索流程 (V2-精确版) ===================
            console.log('[翰林院] 进入多路并行独立检索流程...');

            const allEnabledBases = Object.values(getKnowledgeBases()).filter(b => b.enabled);
            const prioritySourceNames = Object.keys(prioritySettings.sources).filter(
                key => prioritySettings.sources[key] && prioritySettings.sources[key].enabled
            );

            const queryPromises = [];
            let remainingBases = [...allEnabledBases];

            for (const sourceName of prioritySourceNames) {
                const sourceSettings = prioritySettings.sources[sourceName];
                
                const priorityGroup = remainingBases.filter(b => b.source === sourceName);
                remainingBases = remainingBases.filter(b => !priorityGroup.includes(b));

                if (priorityGroup.length > 0) {
                    console.log(`[翰林院] 创建优先查询组: ${sourceName} (${priorityGroup.length}个库)`);
                    const promise = queryVectors(queryText, { includeBases: priorityGroup })
                        .then(candidates => {
                            console.log(`[翰林院] 优先组 ${sourceName} 返回 ${candidates.length} 条结果。`);
                            let processed = candidates.filter(r => r.metadata?.source === sourceName);
                            processed = processed.slice(0, sourceSettings.count);
                            console.log(`[翰林院] 已从 ${sourceName} 池精确提取 ${processed.length} 条结果。`);
                            if (settings.rerank.superSortEnabled) {
                                processed = superSort(processed);
                            }
                            return processed;
                        });
                    queryPromises.push(promise);
                }
            }
            const normalBases = remainingBases;
            if (normalBases.length > 0) {
                console.log(`[翰林院] 创建常规查询组 (${normalBases.length}个库)`);
                const promise = queryVectors(queryText, { includeBases: normalBases })
                    .then(async (candidates) => {
                        console.log(`[翰林院] 常规组返回 ${candidates.length} 条结果。`);
                        console.log('[翰林院] 开始处理常规池...');
                        const rerankOutput = await rerankResults(candidates, queryText, settings);
                        const normalResults = rerankOutput.results;
                        console.log(`[翰林院] 常规池处理完毕，产出 ${(normalResults || []).length} 条结果。`);
                        
                        if (rerankOutput.reranked && settings.rerank.notify) {
                            showNotification('统一检索部分的Rerank已完成', 'success');
                        }
                        
                        return normalResults;
                    });
                queryPromises.push(promise);
            }

            const allResultGroups = await Promise.all(queryPromises);
            finalResults = allResultGroups.flat();

        } else {
            // =================== 传统流程 ===================
            console.log('[翰林院] 进入传统处理流程...');
            const allCandidates = await queryVectors(queryText);
            const rerankOutput = await rerankResults(allCandidates, queryText, settings);
            finalResults = rerankOutput.results;
            if (rerankOutput.reranked && settings.rerank.notify) {
                showNotification('外部Rerank完成', 'success');
            }
        }

        if (!finalResults || finalResults.length === 0) {
            console.log('[翰林院] 最终无可用结果，注入中止。');
            return;
        }
        
        console.log(`[翰林院] 最终准备注入 ${finalResults.length} 条结果。`);
        const resultsBySource = { novel: [], chat_history: [], lorebook: [], manual: [] };
        finalResults.forEach(result => {
            const source = result.metadata?.source;
            if (source && resultsBySource.hasOwnProperty(source)) {
                resultsBySource[source].push(result);
            }
        });

        for (const source in resultsBySource) {
            const results = resultsBySource[source];
            if (results.length === 0) continue;

            const injectionSettings = settings[`injection_${source.replace('_history', '')}`];
            if (!injectionSettings) {
                console.warn(`[翰林院] 未找到来源 '${source}' 的注入设置，跳过处理。`);
                continue;
            }

            // 组内按时序重排 + 断层提示（rerank 决定选哪些块，时序决定呈现顺序）
            const formattedText = _composeInjectionText(source, results);
            const placeholder = `{{${source.replace('_history', '')}_text}}`;
            let injectionContent = injectionSettings.template.replace(placeholder, formattedText);

            if (injectionContent.trim()) {
                injectionContent = `%%${injectionKeys[source]}%%${injectionContent}`;
            }

            setExtensionPrompt(
                injectionKeys[source],
                injectionContent,
                injectionSettings.position,
                injectionSettings.depth,
                false,
                injectionSettings.depth_role
            );
            
            console.log(`[翰林院] 已为来源 '${source}' 注入 ${results.length} 条内容。`);
        }

    } catch (error) {
        console.error('[翰林院] 检索或注入时发生错误:', error);
        if (settings.retrieval.notify) showNotification(`忆识检索失败: ${error.message}`, 'error');
    }
}

async function moveKnowledgeBase(taskId, fromScope) {
    const toScope = fromScope === 'global' ? 'local' : 'global';
    const charId = getCharacterStableId();

    if (!charId && toScope === 'local') {
        toastr.error('移动失败：没有当前角色，无法移入局部知识库。');
        return;
    }

    const sourceBases = fromScope === 'global' ? getGlobalKnowledgeBases() : getLocalKnowledgeBases();
    const targetBases = toScope === 'global' ? getGlobalKnowledgeBases() : getLocalKnowledgeBases();

    const kbData = sourceBases[taskId];

    if (!kbData) {
        const errorMsg = `在源作用域 '${fromScope}' 中未找到ID为 ${taskId} 的知识库。`;
        console.error(`[翰林院-配置] ${errorMsg}`);
        toastr.error('移动失败：未找到源条目。');
        return;
    }

    // 聊天级库（独立聊天记忆产物）专属于单个聊天，移到全局会让所有角色
    // 检索到某个特定聊天的记忆，语义矛盾，禁止
    if (kbData.chatId && toScope === 'global') {
        toastr.warning(`知识库【${kbData.name}】是聊天专属记忆，不能移动到全局。`);
        return;
    }

    if (fromScope === 'local' && toScope === 'global' && !kbData.owner) {
        console.log(`[翰林院-配置] 为旧版知识库 ${taskId} 补充所有者ID: ${charId}`);
        kbData.owner = charId;
    }

    delete sourceBases[taskId];
    targetBases[taskId] = kbData;

    saveSettings();
    
    const message = `知识库【${kbData.name}】已成功移动到${toScope === 'global' ? '全局' : '局部'}。`;
    console.log(`[翰林院-配置] ${message}`);
}

function renameKnowledgeBase(taskId, newName, scope) {
    if (!newName || !newName.trim()) {
        toastr.error('知识库名称不能为空。');
        throw new Error('知识库名称不能为空');
    }

    const bases = scope === 'global' ? getGlobalKnowledgeBases() : getLocalKnowledgeBases();
    const base = bases[taskId];

    if (!base) {
        const errorMsg = `在作用域 '${scope}' 中未找到ID为 ${taskId} 的知识库。`;
        console.error(`[翰林院-配置] ${errorMsg}`);
        toastr.error('重命名失败：未找到知识库条目。');
        throw new Error(errorMsg);
    }

    const oldName = base.name;
    base.name = newName.trim();
    saveSettings();

    const message = `知识库 "${oldName}" 已成功重命名为 "${base.name}"。`;
    console.log(`[翰林院-配置] ${message}`);
    toastr.success(message);
}

async function getAllVectorsFromCollection(collectionId) {
    const queryText = '*';
    const requestBody = {
        collectionId: collectionId,
        searchText: queryText,
        topK: 10000,
        threshold: 0,
        source: 'webllm',
        embeddings: {}
    };

    const queryEmbedding = (await getEmbeddings([queryText]))[0];
    requestBody.embeddings = { [queryText]: queryEmbedding };

    const response = await fetch('/api/vector/query', {
        method: 'POST',
        headers: context.getRequestHeaders(),
        body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
        if (response.status === 404) {
            console.log(`[翰林院-迁移] 集合 ${collectionId} 不存在，返回空数组。`);
            return [];
        }
        const errorText = await response.text();
        throw new Error(`查询集合 ${collectionId} 失败: ${errorText}`);
    }
    const result = await response.json();
    return result.metadata || result.results || result.data || [];
}
