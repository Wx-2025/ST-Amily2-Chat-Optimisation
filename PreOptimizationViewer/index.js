import { renderExtensionTemplateAsync, extension_settings } from '/scripts/extensions.js';
import { POPUP_TYPE, Popup } from '/scripts/popup.js';
import { extensionName } from '../utils/settings.js';
import { applyExclusionRules } from '../core/utils/rag-tag-extractor.js';
import { t, applyTranslations } from '../utils/i18n/index.js';

const preOptimizationViewerPath = `third-party/${extensionName}/PreOptimizationViewer`;
let viewerOrb = null;

// The viewer displays chat/model text inside HTML templates. Keep the text as
// text: this panel is not a rich-text renderer.
function escapeHtmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
function addViewerButton() {
    const button = document.createElement('div');
    button.id = 'pre-optimization-viewer-btn';
    button.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    button.innerHTML = `<i class="fa-solid fa-file-alt"></i><span data-amily-i18n="inspectorUi.viewer.launch">查看优化前文</span>`;
    button.setAttribute('data-amily-i18n-title', 'inspectorUi.viewer.toggleTitle');
    applyTranslations(button);

    const extensionsMenu = document.getElementById('extensionsMenu');
    if (extensionsMenu) {
        extensionsMenu.appendChild(button);
        $(button).on('click', toggleViewerOrb);
    }
}


function toggleViewerOrb() {
    if (viewerOrb && viewerOrb.length > 0) {
        viewerOrb.remove();
        viewerOrb = null;
        toastr.info(t('inspectorUi.viewer.disabled'));
    } else {
        viewerOrb = $(`<div id="viewer-orb" data-amily-i18n-title="inspectorUi.viewer.openTitle"></div>`);
        applyTranslations(viewerOrb[0]);
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        
        viewerOrb.css({
            position: 'fixed',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: isMobile ? '56px' : '50px',
            height: isMobile ? '56px' : '50px',
            minWidth: '44px', 
            minHeight: '44px',
            backgroundColor: 'var(--primary-color)',
            color: 'white',
            borderRadius: '50%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            cursor: 'grab',
            zIndex: '9998',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            transition: 'transform 0.2s ease, box-shadow 0.2s ease',
            userSelect: 'none',
            webkitUserSelect: 'none',
            webkitTouchCallout: 'none',
            webkitTapHighlightColor: 'transparent', 
            touchAction: 'none' 
        });
        viewerOrb.html('<i class="fa-solid fa-file-alt fa-lg"></i>');
        $('body').append(viewerOrb);

        makeDraggable(viewerOrb, showViewerPopup);

        toastr.info(t('inspectorUi.viewer.enabled'));
    }
}

async function renderDiffContent($contentContainer) {
    const snapshot = window.Amily2PreOptimizationSnapshot;

    if (!snapshot || !snapshot.original) {
        $contentContainer.html('<p style="color: grey;" data-amily-i18n="inspectorUi.viewer.empty">尚未捕获到优化前文。</p>');
        applyTranslations($contentContainer[0]);
        return;
    }

    const settings = extension_settings[extensionName];
    let originalText = snapshot.original;

    if (settings.optimizationExclusionEnabled && settings.optimizationExclusionRules?.length > 0) {
        originalText = applyExclusionRules(originalText, settings.optimizationExclusionRules);
    }

    const normalizeWhitespace = (text) => {

        return text.replace(/\n{3,}/g, '\n\n').trim();
    };

    originalText = normalizeWhitespace(originalText);

    if (snapshot.optimized === null) {
        const fallbackHtml = `
            <div class="diff-fallback">
                <h4 data-amily-i18n="inspectorUi.viewer.waiting">正在等待优化结果...</h4>
                <p data-amily-i18n="inspectorUi.viewer.waitingDetail">这通常需要几秒钟的时间。以下是优化前的原始文本（已应用排除和规范化规则）：</p>
                <hr>
                <pre style="white-space: pre-wrap; word-wrap: break-word;">${escapeHtmlText(originalText)}</pre>
            </div>`;
        $contentContainer.html(fallbackHtml);
        applyTranslations($contentContainer[0]);
        return;
    }

    try {
        const DiffMatchPatch = SillyTavern?.libs?.DiffMatchPatch || window.diff_match_patch;
        if (typeof DiffMatchPatch !== 'function') {
            throw new Error('SillyTavern 未提供差异对比库');
        }
        const diffEngine = new DiffMatchPatch();

        const { optimized } = snapshot;

        let cleanedOptimized = optimized.replace(/<!--[\s\S]*?-->/g, '');

        cleanedOptimized = normalizeWhitespace(cleanedOptimized);

        const diff = diffEngine.diff_main(originalText, cleanedOptimized);
        diffEngine.diff_cleanupSemantic(diff);
        
        let diffHtml = '<pre style="white-space: pre-wrap; word-wrap: break-word;">';
        diff.forEach(([operation, value]) => {
            const color = operation === 1 ? 'green' : operation === -1 ? 'red' : 'grey';
            const text = escapeHtmlText(value);
            if (operation === -1) {
                diffHtml += `<del style="color: ${color}; background-color: rgba(255, 0, 0, 0.1); text-decoration: none;">${text}</del>`;
            } else if (operation === 1) {
                diffHtml += `<ins style="color: ${color}; background-color: rgba(0, 255, 0, 0.1); text-decoration: none;">${text}</ins>`;
            } else {
                diffHtml += `<span style="color: ${color};">${text}</span>`;
            }
        });
        diffHtml += '</pre>';
        $contentContainer.html(diffHtml);

    } catch (error) {
        toastr.warning(t('inspectorUi.viewer.diffUnavailable'));
        const fallbackHtml = `<div class="diff-fallback">
                                <h4 data-amily-i18n="inspectorUi.viewer.diffFailed">未能加载差异对比视图</h4>
                                <p data-amily-i18n="inspectorUi.viewer.diffFailedDetail">当前 SillyTavern 环境未提供差异对比组件。以下是优化前后的文本：</p>
                                <hr>
                                <h5 data-amily-i18n="inspectorUi.viewer.before">优化前（已应用排除和规范化规则）</h5>
                                <pre style="white-space: pre-wrap; word-wrap: break-word;">${escapeHtmlText(originalText)}</pre>
                                <hr>
                                <h5 data-amily-i18n="inspectorUi.viewer.after">优化后</h5>
                                <pre style="white-space: pre-wrap; word-wrap: break-word;">${escapeHtmlText(normalizeWhitespace(snapshot.optimized.replace(/<!--[\s\S]*?-->/g, '')))}</pre>
                              </div>`;
        $contentContainer.html(fallbackHtml);
        applyTranslations($contentContainer[0]);
    }
}

async function showViewerPopup() {
    const snapshot = window.Amily2PreOptimizationSnapshot;
    if (!snapshot || !snapshot.original) {
        toastr.info(t('inspectorUi.viewer.noSnapshot'));
        return;
    }

    const templateHtml = await renderExtensionTemplateAsync(preOptimizationViewerPath, 'template');
    const template = $(templateHtml);
    const contentDiv = template.find('#pre-optimization-content');

    await renderDiffContent(contentDiv);

    const popup = new Popup(template, POPUP_TYPE.OK, t('inspectorUi.viewer.title'), {
        wide: true,
        large: true,
        allowVerticalScrolling: true 
    });
    for (const [button, key] of [
        [popup.okButton, 'inspectorUi.viewer.close'],
        [popup.cancelButton, 'inspectorUi.viewer.cancel'],
    ]) {
        button?.removeAttribute('data-i18n');
        button?.setAttribute('data-amily-i18n', key);
    }
    applyTranslations(popup.dlg);
    popup.show();
}


function makeDraggable($element, onClick) {
    let isDragging = false;
    let hasDragged = false;
    let startPos = { x: 0, y: 0 };
    let elementStartPos = { x: 0, y: 0 };

    const getEventCoords = (e) => {
        if (e.touches && e.touches.length > 0) {
            return { x: e.touches[0].clientX, y: e.touches[0].clientY };
        } else if (e.changedTouches && e.changedTouches.length > 0) {
            return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
        }
        return { x: e.clientX, y: e.clientY };
    };

    const keepInBounds = ($elem) => {
        const windowWidth = $(window).width();
        const windowHeight = $(window).height();
        const elemWidth = $elem.outerWidth();
        const elemHeight = $elem.outerHeight();
        
        let currentPos = $elem.offset();
        let newLeft = Math.max(0, Math.min(currentPos.left, windowWidth - elemWidth));
        let newTop = Math.max(0, Math.min(currentPos.top, windowHeight - elemHeight));
        
        $elem.css({
            left: newLeft + 'px',
            top: newTop + 'px',
            transform: 'none'
        });

        localStorage.setItem('preOptimizationViewer_buttonPos', JSON.stringify({
            left: newLeft + 'px',
            top: newTop + 'px'
        }));
    };


    const dragStart = (e) => {
        e.preventDefault();
        
        isDragging = true;
        hasDragged = false;
        
        const coords = getEventCoords(e.originalEvent || e);
        startPos = { x: coords.x, y: coords.y };
        
        const offset = $element.offset();
        elementStartPos = { x: offset.left, y: offset.top };
        
        $element.css({
            'cursor': 'grabbing',
            'user-select': 'none',
            'pointer-events': 'auto',
            'transition': 'none'
        });

        $('body').css({
            'user-select': 'none',
            '-webkit-user-select': 'none',
            'overflow': 'hidden'
        });
    };

    const dragMove = (e) => {
        if (!isDragging) return;

        e.preventDefault();
        
        hasDragged = true;
        
        const coords = getEventCoords(e.originalEvent || e);
        const deltaX = coords.x - startPos.x;
        const deltaY = coords.y - startPos.y;
        
        let newLeft = elementStartPos.x + deltaX;
        let newTop = elementStartPos.y + deltaY;

        const windowWidth = $(window).width();
        const windowHeight = $(window).height();
        const elemWidth = $element.outerWidth();
        const elemHeight = $element.outerHeight();
        
        newLeft = Math.max(0, Math.min(newLeft, windowWidth - elemWidth));
        newTop = Math.max(0, Math.min(newTop, windowHeight - elemHeight));
        
        $element.css({
            left: newLeft + 'px',
            top: newTop + 'px',
            transform: 'none'
        });
    };


    const dragEnd = (e) => {
        if (!isDragging) return;
        
        isDragging = false;
        
        $element.css({
            'cursor': 'grab',
            'user-select': 'auto',
            'transition': 'transform 0.2s ease, box-shadow 0.2s ease' 
        });

        $('body').css({
            'user-select': 'auto',
            '-webkit-user-select': 'auto',
            'overflow': 'auto'
        });

        keepInBounds($element);

        if (!hasDragged && onClick) {

            if (e.type === 'touchend') {
                e.preventDefault();
                setTimeout(onClick, 10); 
            } else {
                onClick();
            }
        }
    };

    $element.on('mousedown', dragStart);
    $element.on('touchstart', dragStart);

    $(document).on('mousemove.draggable', dragMove);
    $(document).on('touchmove.draggable', dragMove);
    $(document).on('mouseup.draggable', dragEnd);
    $(document).on('touchend.draggable', dragEnd);

    $element.on('click', (e) => {
        if (hasDragged) {
            e.preventDefault();
            e.stopPropagation();
        }
    });

    $(window).on('resize.draggable', () => {
        if ($element.length) {
            keepInBounds($element);
        }
    });

    $element.css({
        'cursor': 'grab',
        'user-select': 'none',
        '-webkit-user-select': 'none'
    });
}


function handleTextUpdate() {
    const $popup = $('.popup:visible').filter(function() {
        return $(this).find('#pre-optimization-content').length > 0;
    });

    if ($popup.length > 0) {
        const $contentDiv = $popup.find('#pre-optimization-content');
        renderDiffContent($contentDiv);
        toastr.success(t('inspectorUi.viewer.updated'), t('inspectorUi.viewer.toastTitle'), { timeOut: 2000 });
    }
}


const interval = setInterval(() => {
    if (document.getElementById('extensionsMenu')) {
        clearInterval(interval);
        addViewerButton();
        document.addEventListener('preOptimizationStateUpdated', handleTextUpdate);
    }
}, 500);
