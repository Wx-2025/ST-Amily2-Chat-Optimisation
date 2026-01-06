import { extensionName } from '../utils/settings.js';

let modalInstance = null;
// 状态追踪对象，用于分别管理主模型(A)和并发模型(B)
let trackState = {
    main: { step: 0, text: '准备就绪...', active: false, fillEl: null, textEl: null },
    concurrent: { step: 0, text: '等待启动...', active: false, fillEl: null, textEl: null }
};
const totalEstimatedSteps = 7; // 减少预估步骤数，让进度条跑得更快

// 消息队列系统 - 双轨并行
let messageQueues = {
    main: [],
    concurrent: []
};
let isProcessingQueues = {
    main: false,
    concurrent: false
};
const MIN_DISPLAY_TIME = 800; 

function createModalHtml() {
    return `
        <div id="amily2-progress-bar-container">
            <!-- 主模型轨道 (LLM-A) -->
            <div class="progress-track-container" id="amily2-track-main">
                <div class="progress-header">
                    <div class="progress-status">
                        <i class="fas fa-brain" style="color: #9e8aff;"></i>
                        <span class="track-label">主意识</span>
                        <span class="track-text" id="amily2-text-main">准备就绪...</span>
                    </div>
                    <button id="amily2-progress-cancel" title="中止任务">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                <div class="progress-track">
                    <div class="progress-fill" id="amily2-fill-main" style="width: 0%"></div>
                </div>
            </div>

            <!-- 并发模型轨道 (LLM-B) - 初始隐藏 -->
            <div class="progress-track-container" id="amily2-track-concurrent" style="display: none; margin-top: 12px; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 12px;">
                <div class="progress-header">
                    <div class="progress-status">
                        <i class="fas fa-project-diagram" style="color: #6495ed;"></i>
                        <span class="track-label">潜意识</span>
                        <span class="track-text" id="amily2-text-concurrent">等待启动...</span>
                    </div>
                </div>
                <div class="progress-track">
                    <div class="progress-fill" id="amily2-fill-concurrent" style="width: 0%; background: linear-gradient(90deg, #6495ed, #00d2ff);"></div>
                </div>
            </div>
        </div>
    `;
}

function addStyling() {
    const styleId = 'amily2-progress-modal-style';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.innerHTML = `
        #amily2-progress-bar-container {
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            width: 420px;
            max-width: 90vw;
            background: rgba(30, 30, 40, 0.85);
            backdrop-filter: blur(12px);
            -webkit-backdrop-filter: blur(12px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            padding: 12px 16px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            z-index: 2147483647 !important;
            font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            opacity: 0;
            transform: translate(-50%, -20px); /* 初始位置偏上，用于入场动画 */
        }

        #amily2-progress-bar-container.visible {
            opacity: 1;
            transform: translate(-50%, 0);
        }

        .progress-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .progress-status {
            display: flex;
            align-items: center;
            gap: 8px;
            color: var(--smart-theme-body-color, #eee);
            font-size: 13px;
            font-weight: 500;
            white-space: nowrap;
            overflow: hidden;
            flex: 1;
        }

        .track-label {
            font-size: 11px;
            padding: 2px 6px;
            border-radius: 4px;
            background: rgba(255,255,255,0.1);
            color: rgba(255,255,255,0.8);
            margin-right: 4px;
        }

        .track-text {
            overflow: hidden;
            text-overflow: ellipsis;
            opacity: 0.9;
        }

        #amily2-progress-cancel {
            background: transparent;
            border: none;
            color: rgba(255, 255, 255, 0.4);
            cursor: pointer;
            padding: 4px;
            border-radius: 50%;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 24px;
            height: 24px;
            margin-left: 10px;
        }

        #amily2-progress-cancel:hover {
            background-color: rgba(255, 255, 255, 0.1);
            color: #ff6b6b;
        }

        .progress-track {
            height: 4px;
            background: rgba(255, 255, 255, 0.1);
            border-radius: 2px;
            overflow: hidden;
            position: relative;
        }

        .progress-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--smart-theme-color, #9e8aff), #b3a4ff);
            border-radius: 2px;
            transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 0 10px rgba(158, 138, 255, 0.4);
            position: relative;
        }

        /* 进度条光效动画 */
        .progress-fill::after {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            bottom: 0;
            right: 0;
            background: linear-gradient(
                90deg,
                transparent,
                rgba(255, 255, 255, 0.4),
                transparent
            );
            transform: translateX(-100%);
            animation: shimmer 1.5s infinite;
        }

        @keyframes shimmer {
            100% {
                transform: translateX(100%);
            }
        }
    `;
    document.head.appendChild(style);
}

export function showPlotOptimizationProgress(cancellationState) {
    if (modalInstance) {
        hidePlotOptimizationProgress();
    }

    addStyling();
    document.body.insertAdjacentHTML('beforeend', createModalHtml());
    
    modalInstance = document.getElementById('amily2-progress-bar-container');
    
    // 初始化轨道元素引用
    trackState.main.fillEl = document.getElementById('amily2-fill-main');
    trackState.main.textEl = document.getElementById('amily2-text-main');
    trackState.main.step = 0;
    trackState.main.active = true;

    trackState.concurrent.fillEl = document.getElementById('amily2-fill-concurrent');
    trackState.concurrent.textEl = document.getElementById('amily2-text-concurrent');
    trackState.concurrent.step = 0;
    trackState.concurrent.active = false; // 默认不激活，直到收到相关消息

    const cancelButton = document.getElementById('amily2-progress-cancel');
    
    // 重置消息队列
    messageQueues = {
        main: [],
        concurrent: []
    };
    isProcessingQueues = {
        main: false,
        concurrent: false
    };

    // 触发入场动画
    requestAnimationFrame(() => {
        if (modalInstance) {
            modalInstance.classList.add('visible');
        }
    });

    if (cancellationState && cancelButton) {
        cancelButton.addEventListener('click', () => {
            cancellationState.isCancelled = true;
            if (trackState.main.textEl) trackState.main.textEl.textContent = "正在中止任务...";
            if (trackState.main.fillEl) trackState.main.fillEl.style.backgroundColor = "#ff6b6b";
            toastr.info("记忆管理任务已请求中止。");
            // 延迟关闭以显示中止状态
            setTimeout(hidePlotOptimizationProgress, 800);
        });
    }
}

export function updatePlotOptimizationProgress(message, isDone = false, isSkipped = false) {
    // 如果是最后一步，强制清空所有队列并立即执行
    if (message.includes('记忆重构完成') || message.includes('所有任务已完成')) {
        messageQueues.main = [];
        messageQueues.concurrent = [];
        performUpdate(message, isDone, isSkipped);
        setTimeout(hidePlotOptimizationProgress, 1000);
        return;
    }

    // 判断消息归属
    const isConcurrent = message.includes('(LLM-B)') || message.includes('(并发模型)');
    const queueType = isConcurrent ? 'concurrent' : 'main';

    // 加入对应队列
    messageQueues[queueType].push({ message, isDone, isSkipped });
    
    // 触发对应队列的处理
    processQueue(queueType);
}

async function processQueue(queueType) {
    if (isProcessingQueues[queueType] || messageQueues[queueType].length === 0) return;
    
    isProcessingQueues[queueType] = true;
    
    while (messageQueues[queueType].length > 0) {
        const { message, isDone, isSkipped } = messageQueues[queueType].shift();
        
        // 执行实际的 UI 更新
        performUpdate(message, isDone, isSkipped);
        
        // 如果是“开始”某个步骤（非完成/跳过），或者是重要的完成状态，我们给予展示时间
        // 对于“请求 LLM”这种耗时操作，本身就会卡很久，所以不需要额外延迟，
        // 但对于那些瞬间完成的步骤（如“构建提示词”），我们需要人为暂停一下。
        
        // 简单的策略：所有状态更新都至少展示 MIN_DISPLAY_TIME
        // 除非是 LLM 请求开始，因为那个会自然等待
        const isLongRunningTaskStart = message.includes('请求') && !isDone && !isSkipped;
        
        if (!isLongRunningTaskStart) {
            await new Promise(resolve => setTimeout(resolve, MIN_DISPLAY_TIME));
        } else {
            // 对于 LLM 请求开始，我们只给一个很短的缓冲，让用户看清文字即可，
            // 剩下的时间由 LLM 的实际响应时间填充
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    
    isProcessingQueues[queueType] = false;
}

function performUpdate(message, isDone, isSkipped) {
    if (!modalInstance) return;

    // 过滤掉一些不需要显示的辅助信息
    if (message === '初始化任务...' || message === '所有任务已完成') {
        if (trackState.main.textEl) trackState.main.textEl.textContent = message;
        return;
    }

    // 判断是主模型还是并发模型的消息
    const isConcurrent = message.includes('(LLM-B)') || message.includes('(并发模型)');
    const track = isConcurrent ? trackState.concurrent : trackState.main;
    const trackId = isConcurrent ? 'amily2-track-concurrent' : 'amily2-track-main';

    // 如果是并发模型消息，确保轨道可见
    if (isConcurrent && !track.active) {
        track.active = true;
        const trackEl = document.getElementById(trackId);
        if (trackEl) trackEl.style.display = 'block';
    }

    // 清理消息中的标识符，让显示更干净
    const cleanMessage = message.replace(/\(LLM-[AB]\)|\(主模型\)|\(并发模型\)/g, '').trim();

    if (isDone || isSkipped) {
        track.step++;
        // 计算进度：最大只能到 95%，最后一步直接跳满
        let percentage = Math.min((track.step / totalEstimatedSteps) * 100, 95);
        
        // 如果是最终完成消息，直接满格
        if (message.includes('记忆重构完成') || message.includes('所有任务已完成')) {
            percentage = 100;
            // 同时让并发轨道也满格（如果激活的话）
            if (trackState.concurrent.active && trackState.concurrent.fillEl) {
                trackState.concurrent.fillEl.style.width = '100%';
                if (trackState.concurrent.textEl) trackState.concurrent.textEl.textContent = '同步完成 ✅';
            }
        }

        if (track.fillEl) {
            track.fillEl.style.width = `${percentage}%`;
        }
        
        if (track.textEl) {
            track.textEl.textContent = `${cleanMessage} ${isSkipped ? '⚪' : '✅'}`;
        }
    } else {
        if (track.textEl) {
            track.textEl.textContent = cleanMessage;
        }
    }
}

export function hidePlotOptimizationProgress() {
    // 重置消息队列
    messageQueues = {
        main: [],
        concurrent: []
    };
    isProcessingQueues = {
        main: false,
        concurrent: false
    };

    if (modalInstance) {
        modalInstance.classList.remove('visible');
        setTimeout(() => {
            if (modalInstance) {
                modalInstance.remove();
                modalInstance = null;
                // 清理引用
                trackState.main.fillEl = null;
                trackState.main.textEl = null;
                trackState.concurrent.fillEl = null;
                trackState.concurrent.textEl = null;
            }
        }, 300);
    }
}
