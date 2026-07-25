export const IFRAME_CAPABILITIES = Object.freeze({
    UI: 'ui',
    CHAT_READ: 'chat-read',
    CHAT_WRITE: 'chat-write',
    LOREBOOK_READ: 'lorebook-read',
    LOREBOOK_WRITE: 'lorebook-write',
    SLASH: 'slash',
});

const records = new WeakMap();

const CAPABILITY_LABELS = Object.freeze({
    [IFRAME_CAPABILITIES.UI]: '显示插件通知',
    [IFRAME_CAPABILITIES.CHAT_READ]: '读取当前聊天内容',
    [IFRAME_CAPABILITIES.CHAT_WRITE]: '创建、修改或删除聊天消息',
    [IFRAME_CAPABILITIES.LOREBOOK_READ]: '读取角色卡与世界书资料',
    [IFRAME_CAPABILITIES.LOREBOOK_WRITE]: '创建或修改世界书资料',
    [IFRAME_CAPABILITIES.SLASH]: '执行 SillyTavern Slash 命令',
});

export function registerIframeSource(source, metadata = {}) {
    if (!source || (typeof source !== 'object' && typeof source !== 'function')) return null;
    const record = {
        metadata: {
            messageId: String(metadata.messageId ?? '未知'),
            contentHash: String(metadata.contentHash ?? ''),
        },
        granted: new Set([IFRAME_CAPABILITIES.UI]),
        denied: new Set(),
    };
    records.set(source, record);
    return record;
}

export function unregisterIframeSource(source) {
    if (source && (typeof source === 'object' || typeof source === 'function')) {
        records.delete(source);
    }
}

export function isRegisteredIframeSource(source) {
    return Boolean(source && records.has(source));
}

export function authorizeIframeRequest(source, capability, request, confirmFn = globalThis.confirm) {
    const record = source && records.get(source);
    if (!record) return false;
    if (!capability || capability === IFRAME_CAPABILITIES.UI) return true;
    if (record.granted.has(capability)) return true;
    if (record.denied.has(capability)) return false;

    const label = CAPABILITY_LABELS[capability] || capability;
    const messageId = record.metadata.messageId;
    const prompt = [
        'Amily2 安全确认',
        '',
        `消息 ${messageId} 中自动渲染的 HTML 正在请求：${label}。`,
        `接口：${request}`,
        '',
        '渲染内容可能来自角色卡、世界书或模型回复。仅在你信任该内容时允许。',
        '允许后，该渲染块在本次显示期间可继续使用同一级权限。',
    ].join('\n');
    const approved = typeof confirmFn === 'function' && confirmFn(prompt) === true;
    (approved ? record.granted : record.denied).add(capability);
    return approved;
}
