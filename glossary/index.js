import { executeNovelProcessing } from './executor.js';

const getProcessBtn = () => document.getElementById('novel-confirm-and-process');
const getStatusDisplay = () => document.getElementById('novel-process-status');

export function updateStatus(message, type = 'info') {
    const statusDisplay = getStatusDisplay();
    if (statusDisplay) {
        statusDisplay.textContent = message;
        statusDisplay.style.color = type === 'error' ? '#ff8a8a' : (type === 'success' ? '#8aff8a' : '');
    }
}

export function handleFileUpload(file, callback) {
    if (!file || !file.type.startsWith('text/')) {
        updateStatus('请选择一个有效的 .txt 文件。', 'error');
        return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
        const content = event.target.result;
        updateStatus(`文件 "${file.name}" 已成功加载。`, 'success');
        if (callback) {
            callback(content);
        }
    };
    reader.onerror = () => {
        updateStatus(`读取文件 "${file.name}" 时发生错误。`, 'error');
    };
    reader.readAsText(file);
}

export async function processNovel(processingState) {
    try {
        return await executeNovelProcessing(processingState, updateStatus);
    } catch (error) {
        console.error('处理小说时发生UI层错误:', error);
        updateStatus(`处理失败: ${error.message}`, 'error');
        throw error;
    }
}
