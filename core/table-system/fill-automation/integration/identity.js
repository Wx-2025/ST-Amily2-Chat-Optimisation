import { fail, freeze } from '../validation.js';
import { boundedClone, fingerprint, freshId, normalizeFillLedger, stable } from './metadata.js';

const pendingInvalidations = new WeakMap();
export function invalidateFillMessageIdentity(context, messageIndex) {
    if (!context?.chatMetadata) return;
    const pending = pendingInvalidations.get(context.chatMetadata) ?? new Set();
    pending.add(Number.isSafeInteger(messageIndex) && messageIndex >= 0 ? messageIndex : '*');
    pendingInvalidations.set(context.chatMetadata, pending);
}
export const hasPendingFillIdentityInvalidation = context => (pendingInvalidations.get(context?.chatMetadata)?.size ?? 0) > 0;
export function clearFillIdentityInvalidation(context) { pendingInvalidations.delete(context.chatMetadata); }

function snapshotMessage(message) {
    if (message?.is_system === true || message?.is_hidden === true || message?.extra?.is_hidden === true) return { excluded: true };
    if (!message || typeof message.mes !== 'string' || message.mes.length > 1024 * 1024) fail('FILL_MESSAGE_INVALID');
    const role = message.is_system === true ? 'system' : message.is_user === true ? 'user' : 'assistant';
    // SillyTavern send_date is retained across edit/swipe. Never use content or an array index as identity.
    const hostId = message.extra?.message_id ?? message.message_id;
    const date = message.send_date;
    if ((typeof hostId !== 'string' || !hostId) && (typeof date !== 'string' || !date)) fail('FILL_MESSAGE_IDENTITY_MISSING');
    const anchor = hostId ? ['host', hostId] : ['sent', date, role, message.name ?? ''];
    const swipe = message.swipe_id ?? 0;
    if (!Number.isSafeInteger(swipe) || swipe < 0) fail('FILL_SWIPE_INVALID');
    return { anchor, swipeId: String(swipe), role,
        visible: message.is_system !== true && message.is_hidden !== true && message.extra?.is_hidden !== true,
        text: message.mes };
}

export function captureMessageContent(context) {
    if (!Array.isArray(context?.chat) || context.chat.length > 10000) fail('FILL_CHAT_LIMIT');
    const items = context.chat.map(snapshotMessage);
    if (items.reduce((sum, item) => sum + (item.text?.length ?? 0), 0) > 8 * 1024 * 1024) fail('FILL_CHAT_LIMIT');
    return items;
}

export async function captureFillMessageIdentity(context, ledger, { reconcileInvalidation = false } = {}) {
    const chat = context.chat;
    const raw = captureMessageContent(context);
    const seen = new Set();
    const previous = new Map(ledger.identities.map(item => [item.anchor, item]));
    const messages = [];
    let visiblePosition = 0;
    for (let position = 0; position < raw.length; position++) {
        const item = raw[position];
        if (item.excluded) continue;
        const anchor = await fingerprint(item.anchor);
        if (seen.has(anchor)) fail('FILL_MESSAGE_IDENTITY_AMBIGUOUS');
        seen.add(anchor);
        const contentHash = await fingerprint({ text: item.text, swipeId: item.swipeId, role: item.role, visible: item.visible });
        const old = previous.get(anchor);
        const pending = pendingInvalidations.get(context.chatMetadata);
        const invalidated = reconcileInvalidation && (pending?.has('*') || pending?.has(position));
        const version = String(old?.active ? Number(old.version) + ((old.contentHash !== contentHash || invalidated) ? 1 : 0) : 1);
        const hash = await fingerprint([contentHash, version]);
        // A deleted identity is not resurrected by recreating an identical message.
        messages.push({ id: old?.active ? old.id : freshId(), anchor, version, hash, contentHash,
            swipeId: item.swipeId, role: item.role, visible: item.visible, index: position,
            position: item.visible && item.role !== 'system' ? visiblePosition++ : 0, active: true });
    }
    const rawText = stable(raw);
    const assertCurrent = () => {
        if (context.chat !== chat || stable(captureMessageContent(context)) !== rawText) fail('FILL_MESSAGE_CHANGED');
    };
    assertCurrent();
    const inactive = ledger.identities.filter(item => !seen.has(item.anchor)).map(item => ({ ...item, active: false }));
    const identities = [...messages, ...inactive];
    const changed = stable(ledger.identities) !== stable(identities);
    return { messages: freeze(messages), content: raw, assertCurrent, changed,
        ledger: changed ? normalizeFillLedger({ ...boundedClone(ledger), identities, revision: ledger.revision + 1 }) : ledger };
}

export function coverageMessage(message) {
    return { id: message.id, position: message.position, swipeId: message.swipeId, hash: message.hash };
}
