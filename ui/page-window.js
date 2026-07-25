import { messageFormatting } from '/script.js';

/**
 * 打开 Markdown 教程弹窗。
 * @param {string} title
 * @param {string} contentUrl
 * @param {{ advancedTitle?: string, advancedUrl?: string }} [options]
 *   传入 advancedUrl 时，在正文下方显示「补充进阶教程」按钮。
 */
export async function showContentModal(title, contentUrl, options = {}) {
    try {
        const { advancedTitle, advancedUrl } = options || {};

        const markdownContent = await $.get(contentUrl);
        const htmlContent = messageFormatting(String(markdownContent), '', false, false);

        // 仅入门教程显示「补充进阶」按钮；进阶正文已自带「仍解决不了」，不再二次追加
        const advancedBlock = advancedUrl
            ? `<div class="am2-tut-advanced">
                    <p class="am2-tut-advanced-note">上面是入门。需要全部操作说明时，打开下方进阶教程。</p>
                    <button type="button" class="menu_button secondary interactable am2-tut-advanced-btn">
                        <i class="fas fa-layer-group"></i> 补充进阶教程
                    </button>
                    <p class="am2-tut-help-note">仍解决不了：回首页公告板，点 <b>【01】群</b> 或 <b>【02】群</b> 加群求助。</p>
               </div>`
            : '';

        const dialogHtml = `
            <dialog class="popup wide_dialogue_popup amily2-modal amily2-tutorial-modal">
              <div class="popup-body">
                <h3 style="margin-top:0; color: #eee; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 10px;">
                    <i class="fas fa-book-open" style="color: #58a6ff;"></i> ${escapeHtml(title)}
                </h3>
                <div class="popup-content amily2-tutorial-body" style="height: 60vh; overflow-y: auto; background: rgba(0,0,0,0.2); padding: 15px; border-radius: 5px;">
                    <div class="mes_text amily2-tutorial-md">${htmlContent}</div>
                    ${advancedBlock}
                </div>
                <div class="popup-controls"><div class="popup-button-ok menu_button menu_button_primary interactable">朕已阅</div></div>
              </div>
            </dialog>`;

        const dialogElement = $(dialogHtml).appendTo('body');
        // 表格外包一层，手机可横滑，避免整表被压成一长条竖排
        dialogElement.find('.amily2-tutorial-md table').each(function () {
            if ($(this).parent().hasClass('am2-tut-table-wrap')) return;
            $(this).wrap('<div class="am2-tut-table-wrap"></div>');
        });
        const closeDialog = () => {
            dialogElement[0].close();
            dialogElement.remove();
        };
        dialogElement.find('.popup-button-ok').on('click', closeDialog);
        if (advancedUrl) {
            dialogElement.find('.am2-tut-advanced-btn').on('click', () => {
                closeDialog();
                showContentModal(advancedTitle || `${title} · 进阶`, advancedUrl);
            });
        }
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
        <dialog class="popup wide_dialogue_popup amily2-modal">
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


export function showTableFillReviewModal(rawResponse, callbacks = {}) {
    const {
        title = '填表响应检查',
        subtitle = 'AI未返回有效的 <Amily2Edit> 指令块。您可以在下方查看/编辑原始响应，并选择后续处理方式。',
        onApply,
        onContinue,
        onRetry,
        onCancel,
    } = callbacks;

    const modalHtml = `
        <div class="amily2-fill-review-modal">
            <div class="notes" style="margin-bottom: 10px; color: #ffb74d; line-height: 1.6;">
                <i class="fas fa-exclamation-triangle"></i> ${escapeHtml(subtitle)}
            </div>
            <textarea class="text_pole amily2-fill-review-text"
                style="width: 100%; height: 45vh; resize: vertical; font-family: var(--monoFontFamily, monospace); font-size: 12px; white-space: pre; overflow-wrap: normal; overflow-x: auto;"
            >${escapeHtml(rawResponse || '')}</textarea>
            <div class="notes" style="margin-top: 8px; font-size: 0.85em; opacity: 0.8; line-height: 1.6;">
                <div><b>继续补全</b>：让 AI 基于当前文本继续生成剩余内容，结果会追加到文本框后。</div>
                <div><b>重新填表</b>：舍弃当前响应并重新向 AI 请求同一批次的填表。</div>
                <div><b>手动应用</b>：将文本框中的当前内容直接作为最终结果写入表格（跳过格式校验）。</div>
                <div><b>取消</b>：放弃本次填表，任务暂停。</div>
            </div>
        </div>
    `;

    const dialogElement = showHtmlModal(title, modalHtml, {
        okText: '手动应用',
        cancelText: '取消',
        showCancel: true,
        onOk: (dialog) => {
            const editedText = dialog.find('.amily2-fill-review-text').val();
            if (onApply) {
                onApply(editedText);
            }
        },
        onCancel: () => {
            if (onCancel) {
                onCancel();
            }
        },
    });

    const textarea = dialogElement.find('.amily2-fill-review-text');

    if (typeof onContinue === 'function') {
        const continueButton = $('<button class="menu_button interactable" style="margin-right: auto;"><i class="fas fa-forward"></i> 继续补全</button>');
        continueButton.on('click', async () => {
            const currentText = textarea.val();
            textarea.prop('disabled', true);
            continueButton.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 正在请求补全...');
            try {
                const continued = await onContinue(currentText);
                if (typeof continued === 'string' && continued.length > 0) {
                    textarea.val(continued);
                }
            } catch (err) {
                console.error('[Amily2 填表检查] 补全请求失败:', err);
                if (window.toastr) toastr.error(`补全失败: ${err.message || err}`, '继续补全');
            } finally {
                textarea.prop('disabled', false);
                continueButton.prop('disabled', false).html('<i class="fas fa-forward"></i> 继续补全');
            }
        });
        dialogElement.find('.popup-controls').prepend(continueButton);
    }

    if (typeof onRetry === 'function') {
        const retryButton = $('<button class="menu_button secondary interactable"><i class="fas fa-redo"></i> 重新填表</button>');
        retryButton.on('click', () => {
            dialogElement[0].close();
            dialogElement.remove();
            onRetry();
        });
        const okBtn = dialogElement.find('.popup-button-ok');
        if (okBtn.length) {
            retryButton.insertBefore(okBtn);
        } else {
            dialogElement.find('.popup-controls').append(retryButton);
        }
    }

    return dialogElement;
}

const CWB_WARNING_COUNTDOWN = 10;

/**
 * 角色世界书入口警告弹窗，强制倒计时后才可继续。
 * @param {Function} onProceed - 用户点击"继续使用"时的回调
 * @param {Function} onClose   - 用户点击"关闭退出"时的回调（含弹窗关闭前直接离开）
 */
export function showCwbWarningModal(onProceed, onClose) {
    const dialogHtml = `
        <dialog class="popup wide_dialogue_popup amily2-modal">
          <div class="popup-body">
            <h3 style="margin-top:0; color:#e8a838; border-bottom:1px solid rgba(255,255,255,0.2); padding-bottom:10px;">
                <i class="fas fa-exclamation-triangle" style="color:#e8a838;"></i> 注意 — 角色世界书功能维护状态
            </h3>
            <div style="line-height:1.8; padding:12px 4px; color:var(--SmartThemeBodyColor);">
                该功能长期未进行维护且其实现可被表格及其他功能替代，若非必须一般不建议使用，如确认希望使用，请明确该功能无法获得有效技术支持。
            </div>
            <div class="popup-controls" style="gap:8px;">
                <button class="cwb-warning-close menu_button secondary interactable">关闭退出</button>
                <button class="cwb-warning-proceed menu_button menu_button_primary interactable" disabled>
                    继续使用（<span class="cwb-countdown">${CWB_WARNING_COUNTDOWN}</span>）
                </button>
            </div>
          </div>
        </dialog>`;

    const $dialog = $(dialogHtml).appendTo('body');

    const close = (cb) => {
        clearInterval(timer);
        $dialog[0].close();
        $dialog.remove();
        cb?.();
    };

    $dialog.find('.cwb-warning-close').on('click', () => close(onClose));

    $dialog.find('.cwb-warning-proceed').on('click', function () {
        if (!this.disabled) close(onProceed);
    });

    let remaining = CWB_WARNING_COUNTDOWN;
    const timer = setInterval(() => {
        remaining -= 1;
        $dialog.find('.cwb-countdown').text(remaining);
        if (remaining <= 0) {
            clearInterval(timer);
            const $btn = $dialog.find('.cwb-warning-proceed');
            $btn.prop('disabled', false).html('继续使用');
        }
    }, 1000);

    $dialog[0].showModal();
}
