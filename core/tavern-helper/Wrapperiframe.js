(function(){
    if (window.frameElement) {
        window.frameElement.style.height = 'auto';
    }
    function getGlobal() {
        if (typeof self !== 'undefined') { return self; }
        if (typeof window !== 'undefined') { return window; }
        if (typeof global !== 'undefined') { return global; }
        throw new Error('unable to locate global object');
    }
    const globalScope = getGlobal();
    if (globalScope.generate_send_button_onclick) {
        globalScope.generate_send_button_onclick_old = globalScope.generate_send_button_onclick;
        globalScope.generate_send_button_onclick = function(event) {
            try {
                const textarea = document.getElementById('send_textarea');
                if (textarea && textarea.value) {
                    const customEvent = new CustomEvent('xb-send-message', {
                        detail: {
                            message: textarea.value,
                            event: event
                        },
                        bubbles: true,
                        cancelable: true
                    });
                    if (!window.dispatchEvent(customEvent)) {
                        return;
                    }
                }
            } catch (e) {
                console.error('Error in xb-send-message event dispatch:', e);
            }
            globalScope.generate_send_button_onclick_old(event);
        };
    }
})();
