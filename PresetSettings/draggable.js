export function makeDraggable($element, onClick, storageKey) {
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

        if (storageKey) {
            localStorage.setItem(storageKey, JSON.stringify({
                left: newLeft + 'px',
                top: newTop + 'px'
            }));
        }
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
    
    const namespace = '.draggable' + Date.now();
    $(document).on(`mousemove${namespace}`, dragMove);
    $(document).on(`touchmove${namespace}`, dragMove);
    $(document).on(`mouseup${namespace}`, dragEnd);
    $(document).on(`touchend${namespace}`, dragEnd);
    
    $element.on('click', (e) => {
        if (hasDragged) {
            e.preventDefault();
            e.stopPropagation();
        }
    });
    
    $(window).on(`resize${namespace}`, () => {
        if ($element.length) {
            keepInBounds($element);
        }
    });

    $element.css({
        'cursor': 'grab',
        'user-select': 'none',
        '-webkit-user-select': 'none'
    });

    if (storageKey) {
        const savedPos = localStorage.getItem(storageKey);
        if (savedPos) {
            $element.css(JSON.parse(savedPos));
            setTimeout(() => keepInBounds($element), 0);
        }
    }

    return () => {
        $element.off('mousedown touchstart click');
        $(document).off(namespace);
        $(window).off(namespace);
    };
}
