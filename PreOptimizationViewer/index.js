import { renderExtensionTemplateAsync, extension_settings } from '/scripts/extensions.js';
import { POPUP_TYPE, Popup } from '/scripts/popup.js';
import { extensionName } from '../utils/settings.js';
import { applyExclusionRules } from '../core/utils/rag-tag-extractor.js';

const preOptimizationViewerPath = `third-party/${extensionName}/PreOptimizationViewer`;
let viewerOrb = null;
function addViewerButton() {
    const button = document.createElement('div');
    button.id = 'pre-optimization-viewer-btn';
    button.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    button.innerHTML = `<i class="fa-solid fa-file-alt"></i><span>查看优化前文</span>`;
    button.title = '打开/关闭优化前文查看器';

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
        toastr.info('优化前文查看器已关闭。');
    } else {
        viewerOrb = $(`<div id="viewer-orb" title="点击查看优化前文 (可拖拽)"></div>`);
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

        toastr.info('优化前文查看器已开启。');
    }
}

function loadJsDiff() {
    return new Promise((resolve, reject) => {
        if (window.Diff) {
            resolve();
            return;
        }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jsdiff/5.1.0/diff.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}


async function renderDiffContent($contentContainer) {
    const snapshot = window.Amily2PreOptimizationSnapshot;

    if (!snapshot || !snapshot.original) {
        $contentContainer.html('<p style="color: grey;">尚未捕获到优化前文。</p>');
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
                <h4>正在等待优化结果...</h4>
                <p>这通常需要几秒钟的时间。以下是优化前的原始文本（已应用排除和规范化规则）：</p>
                <hr>
                <pre style="white-space: pre-wrap; word-wrap: break-word;">${originalText.replace(/</g, '<').replace(/>/g, '>')}</pre>
            </div>`;
        $contentContainer.html(fallbackHtml);
        return;
    }

    try {
        await loadJsDiff();
        const { optimized } = snapshot;

        let cleanedOptimized = optimized.replace(/<!--[\s\S]*?-->/g, '');

        cleanedOptimized = normalizeWhitespace(cleanedOptimized);

        const diff = window.Diff.diffLines(originalText, cleanedOptimized, { newlineIsToken: true });
        
        let diffHtml = '<pre style="white-space: pre-wrap; word-wrap: break-word;">';
        diff.forEach(part => {
            const color = part.added ? 'green' : part.removed ? 'red' : 'grey';
            const text = part.value.replace(/</g, '<').replace(/>/g, '>');
            if (part.removed) {
                diffHtml += `<del style="color: ${color}; background-color: rgba(255, 0, 0, 0.1); text-decoration: none;">${text}</del>`;
            } else if (part.added) {
                diffHtml += `<ins style="color: ${color}; background-color: rgba(0, 255, 0, 0.1); text-decoration: none;">${text}</ins>`;
            } else {
                diffHtml += `<span style="color: ${color};">${text}</span>`;
            }
        });
        diffHtml += '</pre>';
        $contentContainer.html(diffHtml);

    } catch (error) {
        toastr.warning('加载差异对比库失败，将分别显示原文。');
        const fallbackHtml = `<div class="diff-fallback">
                                <h4>未能加载差异对比视图</h4>
                                <p>这通常是由于网络问题无法访问 cdnjs.cloudflare.com 导致的。以下是优化前后的文本：</p>
                                <hr>
                                <h5>优化前（已应用排除和规范化规则）</h5>
                                <pre style="white-space: pre-wrap; word-wrap: break-word;">${originalText.replace(/</g, '<').replace(/>/g, '>')}</pre>
                                <hr>
                                <h5>优化后</h5>
                                <pre style="white-space: pre-wrap; word-wrap: break-word;">${normalizeWhitespace(snapshot.optimized.replace(/<!--[\s\S]*?-->/g, '')).replace(/</g, '<').replace(/>/g, '>')}</pre>
                              </div>`;
        $contentContainer.html(fallbackHtml);
    }
}

async function showViewerPopup() {
    const snapshot = window.Amily2PreOptimizationSnapshot;
    if (!snapshot || !snapshot.original) {
        toastr.info('目前没有可供查看的优化前文。');
        return;
    }

    const templateHtml = await renderExtensionTemplateAsync(preOptimizationViewerPath, 'template');
    const template = $(templateHtml);
    const contentDiv = template.find('#pre-optimization-content');

    await renderDiffContent(contentDiv);

    new Popup(template, POPUP_TYPE.OK, '优化前后对比', {
        wide: true,
        large: true,
        allowVerticalScrolling: true 
    }).show();
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
        return $(this).find('.popup-header h4').text().trim() === '优化前后对比';
    });

    if ($popup.length > 0) {
        const $contentDiv = $popup.find('#pre-optimization-content');
        renderDiffContent($contentDiv);
        toastr.success('优化对比已实时更新。', '【查看器】', { timeOut: 2000 });
    }
}


const interval = setInterval(() => {
    if (document.getElementById('extensionsMenu')) {
        clearInterval(interval);
        addViewerButton();
        document.addEventListener('preOptimizationStateUpdated', handleTextUpdate);
    }
}, 500);
