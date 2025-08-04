import { messageFormatting } from '/script.js';

// 动态加载 Showdown.js 解析器
function loadShowdown() {
    return new Promise((resolve, reject) => {
        if (window.showdown) {
            resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/showdown/2.1.0/showdown.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

/**
 * 创建并显示一个包含从URL加载的Markdown内容的模态弹窗。
 * @param {string} title - 弹窗的标题。
 * @param {string} contentUrl - 要加载的Markdown文件的URL。
 */
export async function showContentModal(title, contentUrl) {
    try {
        // 确保Showdown库已加载
        await loadShowdown();

        // 异步获取Markdown文件内容
        const markdownContent = await $.get(contentUrl);

        // 使用Showdown将Markdown转换为HTML，并开启表格等扩展
        const converter = new showdown.Converter({
            tables: true,
            strikethrough: true,
            ghCodeBlocks: true
        });
        const htmlContent = converter.makeHtml(markdownContent);

        // 创建弹窗的HTML结构，复用更新日志的样式
        const dialogHtml = `
            <dialog class="popup wide_dialogue_popup">
              <div class="popup-body">
                <h3 style="margin-top:0; color: #eee; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 10px;">
                    <i class="fas fa-book-open" style="color: #58a6ff;"></i> ${title}
                </h3>
                <div class="popup-content" style="height: 60vh; overflow-y: auto; background: rgba(0,0,0,0.2); padding: 15px; border-radius: 5px;">
                    <div class="mes_text">${htmlContent}</div>
                </div>
                <div class="popup-controls"><div class="popup-button-ok menu_button menu_button_primary interactable">朕已阅</div></div>
              </div>
            </dialog>`;

        // 将弹窗添加到body并显示
        const dialogElement = $(dialogHtml).appendTo('body');
        const closeDialog = () => {
            dialogElement[0].close();
            dialogElement.remove();
        };
        dialogElement.find('.popup-button-ok').on('click', closeDialog);
        dialogElement[0].showModal();

    } catch (error) {
        console.error(`[Amily-翰林院] 紧急报告：加载教程内容 [${title}] 时发生意外:`, error);
        toastr.error(`无法加载教程: ${error.message}`, "翰林院回报");
    }
}

/**
 * 创建并显示一个包含自定义HTML内容的模态弹窗，并提供回调功能。
 * @param {string} title - 弹窗的标题。
 * @param {string} htmlContent - 要在弹窗中显示的HTML字符串。
 * @param {Object} [options={}] - 配置选项
 * @param {string} [options.okText='确认'] - “确认”按钮的文本。
 * @param {string} [options.cancelText='取消'] - “取消”按钮的文本。
 * @param {function} [options.onOk] - 点击“确认”按钮时执行的回调函数。接收弹窗的jQuery元素作为参数。
 * @param {function} [options.onCancel] - 点击“取消”按钮时执行的回调函数。
 * @param {boolean} [options.showCancel=true] - 是否显示“取消”按钮。
 */
export function showHtmlModal(title, htmlContent, options = {}) {
    const {
        okText = '确认',
        cancelText = '取消',
        onOk,
        onCancel,
        showCancel = true,
    } = options;

    // 构建按钮HTML
    const buttonsHtml = `
        ${showCancel ? `<button class="popup-button-cancel menu_button secondary interactable">${cancelText}</button>` : ''}
        <button class="popup-button-ok menu_button menu_button_primary interactable">${okText}</button>
    `;

    const dialogHtml = `
        <dialog class="popup wide_dialogue_popup">
          <div class="popup-body">
            <h3 style="margin-top:0; color: #eee; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 10px;">
                <i class="fas fa-edit" style="color: #58a6ff;"></i> ${title}
            </h3>
            <div class="popup-content" style="height: 60vh; overflow-y: auto; background: rgba(0,0,0,0.2); padding: 15px; border-radius: 5px;">
                ${htmlContent}
            </div>
            <div class="popup-controls" style="display: flex; justify-content: flex-end; gap: 10px;">${buttonsHtml}</div>
          </div>
        </dialog>`;

    const dialogElement = $(dialogHtml).appendTo('body');

    const closeDialog = () => {
        dialogElement[0].close();
        dialogElement.remove();
    };

    dialogElement.find('.popup-button-ok').on('click', () => {
        if (onOk) {
            // 将关闭逻辑交给回调函数决定，或者默认关闭
            const shouldClose = onOk(dialogElement);
            if (shouldClose !== false) {
                closeDialog();
            }
        } else {
            closeDialog();
        }
    });

    if (showCancel) {
        dialogElement.find('.popup-button-cancel').on('click', () => {
            if (onCancel) {
                onCancel();
            }
            closeDialog();
        });
    }

    dialogElement[0].showModal();
    return dialogElement; // 返回弹窗元素以便外部可以操作
}

/**
 * 创建并显示一个用于预览和编辑微言录总结的模态弹窗。
 * @param {string} summaryText - 初始的总结文本。
 * @param {Object} callbacks - 包含各个按钮回调函数的对象。
 * @param {function} callbacks.onConfirm - 点击“确认写入”时的回调，接收编辑后的文本。
 * @param {function} callbacks.onRegenerate - 点击“重新生成”时的回调。
 * @param {function} callbacks.onCancel - 点击“取消写入”时的回调。
 */
export function showSummaryModal(summaryText, callbacks) {
    const { onConfirm, onRegenerate, onCancel } = callbacks;

    const modalHtml = `
        <div class="historiographer-summary-modal">
            <textarea class="text_pole" style="width: 100%; height: 50vh; resize: vertical;">${summaryText}</textarea>
        </div>
    `;

    const dialogElement = showHtmlModal('预览与修订', modalHtml, {
        okText: '确认写入',
        cancelText: '取消写入',
        showCancel: true,
        onOk: (dialog) => {
            const editedText = dialog.find('textarea').val();
            if (onConfirm) {
                onConfirm(editedText);
            }
            // 返回 true 或 undefined 以关闭弹窗
        },
        onCancel: () => {
            if (onCancel) {
                onCancel();
            }
        }
    });

    // 添加“重新生成”按钮
    const regenerateButton = $('<button class="menu_button secondary interactable" style="margin-right: auto;">重新生成</button>');
    regenerateButton.on('click', () => {
        if (onRegenerate) {
            onRegenerate(dialogElement); // 将弹窗元素传递给回调，以便更新内容
        }
    });

    dialogElement.find('.popup-controls').prepend(regenerateButton);
}
