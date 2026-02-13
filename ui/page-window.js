import { messageFormatting } from '/script.js';

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


export async function showContentModal(title, contentUrl) {
    try {

        await loadShowdown();

        const markdownContent = await $.get(contentUrl);

        const converter = new showdown.Converter({
            tables: true,
            strikethrough: true,
            ghCodeBlocks: true
        });
        const htmlContent = converter.makeHtml(markdownContent);

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


export function showHtmlModal(title, htmlContent, options = {}) {
    const {
        okText = '确认',
        cancelText = '取消',
        onOk,
        onCancel,
        onShow,
        showCancel = true,
    } = options;

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
    if (onShow) {
        onShow(dialogElement);
    }
    return dialogElement; 
}


function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

export function showSummaryModal(summaryText, callbacks) {
    const { onConfirm, onRegenerate, onCancel } = callbacks;

    const modalHtml = `
        <div class="historiographer-summary-modal">
            <textarea class="text_pole" style="width: 100%; height: 50vh; resize: vertical;">${escapeHtml(summaryText)}</textarea>
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

        },
        onCancel: () => {
            if (onCancel) {
                onCancel();
            }
        }
    });

    const regenerateButton = $('<button class="menu_button secondary interactable" style="margin-right: auto;">重新生成</button>');
    regenerateButton.on('click', () => {
        if (onRegenerate) {
            dialogElement[0].close();
            onRegenerate(dialogElement); 
        }
    });

    dialogElement.find('.popup-controls').prepend(regenerateButton);
}
