import * as state from './prese_state.js';

let draggedItem = null;
let draggedSection = null;
let draggedOrderIndex = null;
let isDragging = false;
let startY = 0;
let startX = 0;
let dragThreshold = 5;
let dragPlaceholder = null;
let scrollInterval = null;
let scrollContainer = null;

function createDragPlaceholder() {
    return $('<div class="drag-placeholder" style="height: 2px; background-color: #007bff; margin: 2px 0; opacity: 0.8;"></div>');
}

function getEventPosition(e) {
    if (e.type.includes('touch')) {
        const touch = e.originalEvent.touches[0] || e.originalEvent.changedTouches[0];
        return { x: touch.clientX, y: touch.clientY };
    }
    return { x: e.clientX, y: e.clientY };
}

function findTargetItem(x, y) {
    const elements = document.elementsFromPoint(x, y);
    for (let element of elements) {
        const $element = $(element);
        const $mixedItem = $element.closest('.mixed-item');
        if ($mixedItem.length && !$mixedItem.is(draggedItem)) {
            return $mixedItem;
        }
    }
    return null;
}

function onDragStart(e, item) {
    e.preventDefault();
    draggedItem = item;
    draggedSection = draggedItem.data('section');
    draggedOrderIndex = draggedItem.data('order-index');

    // 修复：直接查找固定的滚动容器
    scrollContainer = $('#amily2-preset-settings-popup').find('#prompt-editor-container');
    
    const pos = getEventPosition(e);
    startX = pos.x;
    startY = pos.y;
    isDragging = false;

    $(document).on('mousemove touchmove', onDragMove);
    $(document).on('mouseup touchend', onDragEnd);
}

function onDragMove(e) {
    const pos = getEventPosition(e);
    const deltaX = Math.abs(pos.x - startX);
    const deltaY = Math.abs(pos.y - startY);

    if (!isDragging && (deltaX > dragThreshold || deltaY > dragThreshold)) {
        isDragging = true;
        draggedItem.addClass('dragging');
        draggedItem.css({
            'opacity': '0.5',
            'transform': 'rotate(2deg)'
        });

        dragPlaceholder = createDragPlaceholder();
        draggedItem.after(dragPlaceholder);
    }

    if (isDragging) {
        const targetItem = findTargetItem(pos.x, pos.y);
        
        if (targetItem && targetItem.data('section') === draggedSection) {
            const targetRect = targetItem[0].getBoundingClientRect();
            const targetMiddle = targetRect.top + targetRect.height / 2;
            
            if (pos.y < targetMiddle) {
                targetItem.before(dragPlaceholder);
            } else {
                targetItem.after(dragPlaceholder);
            }
        }

        handleAutoScroll(pos.y);
    }
}

function onDragEnd(e) {
    $(document).off('mousemove touchmove', onDragMove);
    $(document).off('mouseup touchend', onDragEnd);

    if (isDragging) {
        completeDrag();
    }

    resetDragState();
    stopAutoScroll();
}

function completeDrag() {
    if (!draggedItem || !dragPlaceholder) return;

    const sectionContainer = dragPlaceholder.closest('.mixed-list');
    dragPlaceholder.before(draggedItem);

    const newOrder = [];
    sectionContainer.find('.mixed-item').each(function(index) {
        const $item = $(this);
        $item.attr('data-order-index', index); // 更新UI索引属性

        const type = $item.data('type');
        if (type === 'prompt') {
            newOrder.push({
                type: 'prompt',
                index: parseInt($item.data('prompt-index'), 10)
            });
        } else if (type === 'conditional') {
            newOrder.push({
                type: 'conditional',
                id: $item.data('conditional-id')
            });
        }
    });

    const allOrders = state.getCurrentMixedOrder();
    allOrders[draggedSection] = newOrder;
    state.setCurrentMixedOrder(allOrders);
    
    toastr.info('顺序已调整，请点击保存按钮以生效。', '', { timeOut: 3000 });
}

function resetDragState() {
    if (draggedItem) {
        draggedItem.removeClass('dragging');
        draggedItem.css({
            'opacity': '',
            'transform': ''
        });
    }
    
    if (dragPlaceholder) {
        dragPlaceholder.remove();
        dragPlaceholder = null;
    }
    
    draggedItem = null;
    draggedSection = null;
    draggedOrderIndex = null;
    isDragging = false;
}

function handleAutoScroll(clientY) {
    let containerElement = scrollContainer ? scrollContainer[0] : null;
    if (!containerElement) return;

    const containerRect = containerElement.getBoundingClientRect();
    const scrollZone = 120; 
    const scrollSpeed = 15; 

    stopAutoScroll(); 

    if (clientY < containerRect.top + scrollZone) {
        scrollInterval = setInterval(() => {
            containerElement.scrollTop -= scrollSpeed;
            if (containerElement.scrollTop <= 0) stopAutoScroll();
        }, 50);
    } else if (clientY > containerRect.bottom - scrollZone) {
        scrollInterval = setInterval(() => {
            containerElement.scrollTop += scrollSpeed;
            if (containerElement.scrollTop >= containerElement.scrollHeight - containerElement.clientHeight) stopAutoScroll();
        }, 50);
    }
}

function stopAutoScroll() {
    if (scrollInterval) {
        clearInterval(scrollInterval);
        scrollInterval = null;
    }
}

export function bindDragEvents(context) {
    context.find('.drag-handle').off('mousedown.amily2 touchstart.amily2').on('mousedown.amily2 touchstart.amily2', function(e) {
        onDragStart(e, $(this).closest('.mixed-item'));
    });
}
