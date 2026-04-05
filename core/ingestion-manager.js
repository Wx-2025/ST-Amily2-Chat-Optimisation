

'use strict';

const STORAGE_PREFIX = 'hly_ingestion_job_';

function generateJobId(file) {
    if (!file) return null;
    // 使用文件名、大小和最后修改时间来创建一个相对稳定的唯一ID
    return `${file.name}_${file.size}_${file.lastModified}`;
}

function saveProgress(jobId, processedChunks, totalChunks) {
    if (!jobId) return;
    const jobState = {
        processedChunks,
        totalChunks,
        timestamp: Date.now(),
    };
    try {
        localStorage.setItem(STORAGE_PREFIX + jobId, JSON.stringify(jobState));
        console.log(`[任务总管] 已为任务 ${jobId} 保存进度: ${processedChunks}/${totalChunks}`);
    } catch (e) {
        console.error('[任务总管] 保存进度失败，可能是localStorage已满。', e);
    }
}

function loadProgress(jobId) {
    if (!jobId) return null;
    try {
        const savedState = localStorage.getItem(STORAGE_PREFIX + jobId);
        if (savedState) {
            console.log(`[任务总管] 已为任务 ${jobId} 找到存档。`);
            return JSON.parse(savedState);
        }
        return null;
    } catch (e) {
        console.error(`[任务总管] 加载任务 ${jobId} 进度失败。`, e);
        return null;
    }
}

function clearJob(jobId) {
    if (!jobId) return;
    localStorage.removeItem(STORAGE_PREFIX + jobId);
    console.log(`[任务总管] 已清理任务 ${jobId} 的存档。`);
}

export {
    generateJobId,
    saveProgress,
    loadProgress,
    clearJob,
};
