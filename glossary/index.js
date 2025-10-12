import { executeNovelProcessing } from './executor.js';

let novelText = null;
let recognizedChaptersList = [];

const getNovelFileInput = () => document.getElementById('novel-file-input');
const getChapterRegexInput = () => document.getElementById('novel-chapter-regex');
const getRecognizeBtn = () => document.getElementById('novel-recognize-chapters');
const getProcessBtn = () => document.getElementById('novel-confirm-and-process');
const getChapterPreview = () => document.getElementById('novel-chapter-preview');
const getChapterCount = () => document.getElementById('novel-chapter-count');
const getStatusDisplay = () => document.getElementById('novel-process-status');
const getPresetSelect = () => document.getElementById('novel-preset-select');
const getBatchSizeInput = () => document.getElementById('novel-batch-size');
const getForceNewCheckbox = () => document.getElementById('novel-force-new');

export function updateStatus(message, type = 'info') {
    const statusDisplay = getStatusDisplay();
    if (statusDisplay) {
        statusDisplay.textContent = message;
        statusDisplay.style.color = type === 'error' ? '#ff8a8a' : (type === 'success' ? '#8aff8a' : '');
    }
}

function resetChapterUI() {
    const preview = getChapterPreview();
    const count = getChapterCount();
    const processBtn = getProcessBtn();
    if (preview) preview.innerHTML = '<small>请先上传文件并识别章节...</small>';
    if (count) count.textContent = '0';
    if (processBtn) processBtn.disabled = true;
    recognizedChaptersList = [];
}

export function handleFileUpload(file) {
    if (!file || !file.type.startsWith('text/')) {
        updateStatus('请选择一个有效的 .txt 文件。', 'error');
        return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
        novelText = event.target.result;
        updateStatus(`文件 "${file.name}" 已成功加载。请点击“识别章节”。`, 'success');
        resetChapterUI();
    };
    reader.onerror = () => {
        updateStatus(`读取文件 "${file.name}" 时发生错误。`, 'error');
        novelText = null;
    };
    reader.readAsText(file);
}

export function recognizeChapters() {
    if (!novelText) {
        updateStatus('请先上传一个小说文件。', 'error');
        return;
    }
    const regexInput = getChapterRegexInput();
    const customRegex = regexInput.value.trim();
    const defaultRegex = '(^\\s*(?:(?:第|卷)\\s*[一二三四五六七八九十百千万零〇\\d]+\\s*[章回节部篇]|Chapter\\s+\\d+|\\d+\\s*[.、]|序章|楔子|引子|序幕|尾声|终章|后记|番外)\\s*.*)';
    let finalRegex;
    try {
        finalRegex = new RegExp(customRegex || defaultRegex, 'gm');
    } catch (e) {
        updateStatus('无效的正则表达式。', 'error');
        return;
    }

    updateStatus('正在识别章节...', 'info');
    recognizedChaptersList = [];
    const matches = [...novelText.matchAll(finalRegex)];

    if (matches.length > 0) {
        for (let i = 0; i < matches.length; i++) {
            const currentMatch = matches[i];
            const nextMatch = matches[i + 1];

            const title = currentMatch[0].trim();
            const startIndex = currentMatch.index + currentMatch[0].length;
            const endIndex = nextMatch ? nextMatch.index : novelText.length;

            const content = novelText.substring(startIndex, endIndex).trim();

            if (title) {
                recognizedChaptersList.push({ title, content });
            }
        }
    }

    const preview = getChapterPreview();
    const count = getChapterCount();
    const processBtn = getProcessBtn();

    if (preview) {
        preview.innerHTML = recognizedChaptersList.map((chap, index) => `<div>${index + 1}. ${chap.title}</div>`).join('');
    }
    if (count) {
        count.textContent = recognizedChaptersList.length;
    }

    if (recognizedChaptersList.length > 0) {
        processBtn.disabled = false;
        updateStatus(`成功识别 ${recognizedChaptersList.length} 个章节。请预览并确认。`, 'success');
    } else {
        updateStatus('未能识别出章节。请尝试调整正则表达式或检查文件内容。', 'error');
        processBtn.disabled = true;
    }
}

export async function processNovel() {
    const processBtn = getProcessBtn();
    processBtn.disabled = true;

    try {
        const batchSize = parseInt(getBatchSizeInput().value, 10);
        const forceNew = getForceNewCheckbox().checked;

        await executeNovelProcessing(recognizedChaptersList, batchSize, forceNew, updateStatus);

    } catch (error) {
        console.error('处理小说时发生UI层错误:', error);
        updateStatus(`处理失败: ${error.message}`, 'error');
    } finally {
        processBtn.disabled = false;
    }
}
