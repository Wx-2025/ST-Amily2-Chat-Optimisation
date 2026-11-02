/** A redacted preview is the only UI input; the controller retains the source and commit capability. */
import { CHAT_LEDGER_KEY, CHAT_LEDGER_MAX_BYTES, chatLedgerIdentity, chatLedgerTarget, chatMessageImage } from '../core/historiography/chat-ledger.js';
import { createUnverifiedChatTransferSource } from '../core/historiography/chat-transfer.js';
import { captureChatScope, chatScopesMatch } from '../core/table-system/infra/chat-scope.js';
import { captureHistoriographyOperationLease, assertHistoriographyOperationLease } from '../core/historiography/operation-lease.js';
import { t as translate } from '../utils/i18n/index.js';

const transferKinds = new Map([['import', 'ImportKind'], ['branch', 'BranchKind'], ['rename', 'RenameKind'], ['card-update', 'CardUpdateKind']]);
const transferModes = new Map([['resume', 'ResumeMode'], ['snapshot', 'SnapshotMode']]);
// Exact display-only mappings: keep core preview capabilities and unknown diagnostics untouched.
const transferNotices = new Map([
    ['Message hashes prove equality with the selected snapshot, not stable host identity or summary authorship.', 'WarningMessageHashes'],
    ['Host persistence has no cross-window compare-and-swap; do not edit this chat in another window.', 'WarningOtherWindows'],
    ['Background text may describe another branch; no processing cursor is imported.', 'WarningBackgroundBranch'],
    ['The target already has a summary; it will not be overwritten.', 'ConflictTargetSummary'],
    ['The copied target metadata is not the selected source revision.', 'ConflictSourceRevision'],
    ['Source messages are missing; only a background snapshot is available.', 'ConflictMissingMessages'],
    ['Coverage must end at a verified complete summary boundary within the target chat.', 'ConflictCoverage'],
    ['Rename requires the entire source chat and summary coverage to match.', 'ConflictRename'],
    ['A branch requires a different target identity.', 'ConflictBranchIdentity'],
    ['A retained segment has unknown archive coverage; export a background snapshot instead.', 'ConflictArchiveCoverage'],
    ['Matching card names do not prove continuity; confirm the selected source belongs to the previous card version.', 'WarningCardNames'],
    ['Card update continuation requires a source and target character chat.', 'ConflictCardChats'],
    ['Card update continuation requires a different target chat identity.', 'ConflictCardIdentity'],
    ['Card update continuation requires all source messages as an unchanged prefix and the complete source summary progress.', 'ConflictCardCoverage'],
]);

export function showChatSummaryTransferDialog({ preview, showHtmlModal, escapeHtml, confirm, onSaved = () => {}, t = translate }) {
    const e = value => escapeHtml(String(value ?? ''));
    const tr = (key, params) => t(`summaryWorkflow.transfer${key}`, params);
    const display = (labels, value) => labels.has(value) ? tr(labels.get(value)) : value;
    const versionNotice = preview.kind === 'card-update'
        && preview.sameCharacterName === true && preview.characterVersionChanged === true
        ? `Same-name card version differs: ${preview.sourceCharacterVersion} -> ${preview.targetCharacterVersion}. Confirm the selected source; versions do not prove chat continuity.`
        : null;
    const list = items => items.map(item => `<li>${e(item === versionNotice
        ? tr('WarningCardVersion', { sourceVersion: preview.sourceCharacterVersion, targetVersion: preview.targetCharacterVersion })
        : display(transferNotices, item))}</li>`).join('');
    let submitted = false;
    return showHtmlModal(tr('Title'), `
      <div class="amily2-chat-transfer" style="max-height:65vh;overflow:auto;overflow-wrap:anywhere">
        <dl>
          <dt>${e(tr('Operation'))}</dt><dd>${e(display(transferKinds, preview.kind))} / ${e(display(transferModes, preview.mode))}</dd>
          ${preview.kind === 'card-update' ? `
          <dt>${e(tr('SourceCard'))}</dt><dd>${e(preview.sourceCharacterName || tr('UnknownCardName'))}</dd>
          <dt>${e(tr('TargetCard'))}</dt><dd>${e(preview.targetCharacterName || tr('UnknownCardName'))}</dd>
          <dt>${e(tr('SourceCardVersion'))}</dt><dd>${e(preview.sourceCharacterVersion || tr('UnknownCardVersion'))}</dd>
          <dt>${e(tr('TargetCardVersion'))}</dt><dd>${e(preview.targetCharacterVersion || tr('UnknownCardVersion'))}</dd>` : ''}
          <dt>${e(tr('Source'))}</dt><dd>${e(preview.sourceIdentity)}</dd>
          <dt>${e(tr('Target'))}</dt><dd>${e(preview.targetIdentity)}</dd>
          <dt>${e(tr('Revisions'))}</dt><dd>${e(preview.sourceRevision)} / ${e(preview.ledgerRevision)} / ${e(preview.targetRevision)}</dd>
          <dt>${e(tr('Coverage'))}</dt><dd>${e(preview.sourceFloor)} / ${e(preview.maximumFloor)} / ${e(preview.keepThroughFloor)}</dd>
        </dl>
        <ul role="status">${list(preview.warnings || [])}</ul>
        <ul role="alert">${list(preview.conflicts || [])}</ul>
        ${preview.canConfirm ? `<label class="checkbox_label"><input type="checkbox" class="amily2-chat-transfer-confirm">${e(tr(preview.kind === 'card-update' ? 'CardConsent' : 'Consent'))}</label>` : ''}
        <div class="amily2-chat-transfer-error notes" role="alert" hidden></div>
      </div>`, {
        okText: preview.canConfirm ? tr('Save') : t('summaryWorkflow.close'), cancelText: t('actions.cancel'),
        onOk: dialog => {
            if (!preview.canConfirm) return true;
            if (submitted) return false;
            const errorBox = dialog.find('.amily2-chat-transfer-error');
            if (!dialog.find('.amily2-chat-transfer-confirm').prop('checked')) {
                errorBox.text(tr('MustConfirm')).prop('hidden', false);
                return false;
            }
            submitted = true;
            dialog.find('input, .popup-button-ok, .popup-button-cancel').prop('disabled', true);
            void (async () => {
                try {
                    const result = await confirm(preview, { confirmed: true });
                    if (!result?.committed) throw new Error(tr('NotSaved'));
                    dialog[0].close();
                    dialog.remove();
                    void Promise.resolve().then(() => onSaved(result)).catch(error =>
                        console.warn('[Chat summary] Saved; UI refresh failed:', error?.code || 'refresh-failed'));
                } catch (error) {
                    errorBox.text(error.committed
                        ? tr('AcceptedChanged')
                        : tr('RetryPreview', { error: error.message })).prop('hidden', false);
                    // Preview capabilities are single-use, including failed attempts.
                    dialog.find('.popup-button-cancel').prop('disabled', false);
                }
            })();
            return false;
        },
    });
}

/** Bind the three explicit commands without keeping imported bodies in DOM or global settings. */
export function bindChatSummaryTransferControls({ root, getContext, getSettings, getAuthState,
    exportSource, exportRaw, previewTransfer, confirmTransfer, showHtmlModal, escapeHtml, t,
    download, onError, onSaved = () => {} }) {
    const find = id => root.querySelector(`#historiography_transfer_${id}`);
    const controls = Object.fromEntries(['export', 'raw', 'import', 'background', 'file', 'kind', 'mode'].map(id => [id, find(id)]));
    if (Object.values(controls).some(element => !element)) return { refresh() {}, dispose() {} };
    let busy = false;
    let disposed = false;
    let fileBoundary = null;
    const tr = (key, params) => t(`summaryWorkflow.transfer${key}`, params);
    const listeners = [];
    const listen = (element, type, callback) => {
        element.addEventListener(type, callback);
        listeners.push(() => element.removeEventListener(type, callback));
    };
    const refresh = () => {
        const disabled = busy || getSettings()?.historiographyStorageMode === 'worldbook';
        Object.values(controls).forEach(element => { element.disabled = disabled; });
    };
    function boundary() {
        const context = getContext();
        const scope = captureChatScope(context);
        const identity = chatLedgerIdentity(context);
        const messages = chatMessageImage(context.chat);
        const metadata = JSON.stringify(context.chatMetadata?.[CHAT_LEDGER_KEY]);
        const lease = captureHistoriographyOperationLease({ authState: getAuthState(), targetKey: identity,
            contextKey: `${identity}:${scope.epoch}` });
        const assertCurrent = () => {
            const current = getContext();
            const currentIdentity = chatLedgerIdentity(current);
            assertHistoriographyOperationLease(lease, { authState: getAuthState(), targetKey: currentIdentity,
                contextKey: `${currentIdentity}:${captureChatScope(current).epoch}` });
            if (disposed || !identity || getSettings()?.historiographyStorageMode === 'worldbook'
                || !chatScopesMatch(scope, captureChatScope(current)) || messages !== chatMessageImage(current.chat)
                || metadata !== JSON.stringify(current.chatMetadata?.[CHAT_LEDGER_KEY])) throw new Error(tr('ContextChanged'));
        };
        assertCurrent();
        return assertCurrent;
    }
    async function run(operation) {
        if (busy || disposed) return;
        busy = true; refresh();
        try { await operation(); } catch (error) { onError(error); }
        finally { busy = false; if (!disposed) refresh(); }
    }
    async function preview(readSource, guard, kind, mode) {
        guard();
        const snapshot = await previewTransfer({ kind, mode, readSource: async () => {
            guard();
            const source = await readSource();
            guard();
            return source;
        } });
        guard();
        showChatSummaryTransferDialog({ preview: snapshot, showHtmlModal, escapeHtml, t,
            confirm: async (candidate, options) => { guard(); return confirmTransfer(candidate, options); },
            onSaved });
    }
    const offerExport = raw => {
        if (busy) return;
        let guard;
        try { guard = boundary(); } catch (error) { onError(error); return; }
        showHtmlModal(tr(raw ? 'Raw' : 'Export'), `<p>${escapeHtml(tr('Privacy'))}</p>`, {
            okText: tr('Download'), cancelText: t('actions.cancel'),
            onOk: () => { void run(async () => {
                guard();
                const target = raw ? await chatLedgerTarget(getContext()) : null;
                guard();
                const source = raw ? await exportRaw(target) : await exportSource();
                guard();
                if (!source) throw new Error(tr('NoSource'));
                const json = JSON.stringify(source, null, 2);
                if (new TextEncoder().encode(json).byteLength > CHAT_LEDGER_MAX_BYTES) throw new Error(tr('TooLarge'));
                download(json, `amily2-chat-${raw ? 'raw-backup' : 'transfer'}-${Date.now()}.json`);
            }); },
        });
    };
    listen(controls.export, 'click', () => offerExport(false));
    listen(controls.raw, 'click', () => offerExport(true));
    listen(controls.import, 'click', () => {
        if (busy) return;
        try {
            fileBoundary = boundary();
            controls.file.value = '';
            controls.file.click();
        } catch (error) { fileBoundary = null; onError(error); }
    });
    listen(controls.file, 'change', () => {
        const file = controls.file.files?.[0];
        const guard = fileBoundary;
        fileBoundary = null;
        const kind = controls.kind.value;
        const mode = controls.mode.value;
        if (!file || !guard) return;
        void run(async () => {
            guard();
            if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > CHAT_LEDGER_MAX_BYTES) throw new Error(tr('TooLarge'));
            const text = await file.text();
            guard();
            if (new TextEncoder().encode(text).byteLength > CHAT_LEDGER_MAX_BYTES) throw new Error(tr('TooLarge'));
            let source;
            try { source = JSON.parse(text); } catch { throw new Error(tr('InvalidJson')); }
            await preview(() => source, guard, kind, mode);
        });
    });
    listen(controls.background, 'click', () => {
        void run(async () => {
            const guard = boundary();
            const target = await chatLedgerTarget(getContext());
            guard();
            // Re-read raw metadata at confirmation; never manufacture source message evidence here.
            await preview(async () => createUnverifiedChatTransferSource(await exportRaw(target)), guard,
                controls.kind.value, 'snapshot');
        });
    });
    refresh();
    return { refresh, dispose() { disposed = true; fileBoundary = null; listeners.forEach(remove => remove()); } };
}
