import { loadBookFresh, mutateBookStrict } from '../core/historiography/storage.js';
import { getContext, extension_settings } from '/scripts/extensions.js';
import { chatLedgerTarget, isChatLedgerTarget } from '../core/historiography/chat-ledger.js';
import { extensionName } from '../utils/settings.js';
import { pluginAuthStatus } from '../utils/auth-state.js';
import { captureEntryEditorContext } from './entry-context.js';
import { createEntryManager } from '../core/historiography/entry-management.js';
import { t } from '../utils/i18n/index.js';
import { showHtmlModal } from '../ui/page-window.js';

export function confirmEntryAction(message) {
    return new Promise(resolve => {
        let settled = false;
        const finish = value => { if (!settled) { settled = true; resolve(value); } };
        showHtmlModal(t('worldEditorUi.safe.previewTitle'), '<p class="entry-action-confirm"></p>', {
            onShow(dialog) {
                dialog.find('.entry-action-confirm')[0].textContent = message;
                dialog[0].addEventListener('close', () => finish(false), { once: true });
                dialog[0].addEventListener('cancel', () => finish(false), { once: true });
            },
            onCancel: () => finish(false),
            onOk() { finish(true); return true; },
        });
    });
}

export async function confirmLedgerRemoval(preview) {
    return new Promise(resolve => {
        let settled = false;
        const finish = value => { if (!settled) { settled = true; resolve(value); } };
        showHtmlModal(t('worldEditorUi.safe.previewTitle'), '<div class="entry-removal-preview"></div>', {
            onShow(dialog) {
                const container = dialog.find('.entry-removal-preview')[0];
                const notice = document.createElement('p');
                notice.textContent = t(preview.resetProgress ? 'worldEditorUi.safe.activeWarning' : 'worldEditorUi.safe.archiveWarning');
                const list = document.createElement('ul');
                list.style.maxHeight = '40vh'; list.style.overflowY = 'auto';
                for (const entry of preview.entries) {
                    const item = document.createElement('li');
                    item.textContent = `UID ${entry.uid} · ${entry.comment} (${entry.kind})`;
                    list.append(item);
                }
                container.append(notice, list);
                dialog[0].addEventListener('close', () => finish(false), { once: true });
                dialog[0].addEventListener('cancel', () => finish(false), { once: true });
            },
            onCancel: () => finish(false),
            onOk() { finish(true); return true; },
        });
    });
}

export async function prepareLedgerRemoval(bookName, assertCurrent) {
    const { pauseForLedgerEntryRemoval } = await import('../core/historiographer.js');
    assertCurrent();
    pauseForLedgerEntryRemoval(bookName);
}

export async function downloadEntryBackup(name, data) {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ ...data }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')}-before-edit-${Date.now()}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    // A click does not prove the browser saved the file.
    return confirmEntryAction(t('worldEditorUi.safe.backupConfirm'));
}

export const captureEntryScope = name => captureEntryEditorContext({ name, getContext,
    getMode: () => extension_settings[extensionName]?.historiographyStorageMode ?? 'worldbook',
    getAuth: () => pluginAuthStatus });
export async function currentChatEntryTarget() {
    const target = await chatLedgerTarget(getContext());
    if (!target) throw Object.assign(new Error('ENTRY_CHAT_REQUIRED'), { code: 'ENTRY_CHAT_REQUIRED' });
    return target;
}
export const safeEntryManager = createEntryManager({ load: loadBookFresh,
    mutate: (name, fn) => mutateBookStrict(name, fn, { verifyAfterSave: isChatLedgerTarget(name) }), backup: downloadEntryBackup });
export { loadBookFresh };
export { isChatLedgerTarget };

export function safeEntryMessage(error) {
    const key = `worldEditorUi.safe.${error?.code}`;
    const message = t(key);
    return message === key ? t('worldEditorUi.safe.unknown') : message;
}
