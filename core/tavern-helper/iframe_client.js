
function initializeAmilyClient() {
    console.log('[Amily2-IframeClient] 正在初始化...');

    document.body.addEventListener('click', function(event) {
        const target = event.target.closest('[data-amily-action]');
        
        if (target) {
            const action = target.dataset.amilyAction;
            const detail = { ...target.dataset };

            delete detail.amilyAction;

            console.log(`[Amily2-IframeClient] 触发动作: ${action}`, detail);

            if (window.AmilySimpleAPI && typeof window.AmilySimpleAPI.post === 'function') {
                window.AmilySimpleAPI.post(action, detail);
            } else {
                console.error('[Amily2-IframeClient] AmilySimpleAPI 不可用。');
            }
        }
    });

    console.log('[Amily2-IframeClient] 客户端脚本已加载并就绪。');
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeAmilyClient);
} else {
    initializeAmilyClient();
}
