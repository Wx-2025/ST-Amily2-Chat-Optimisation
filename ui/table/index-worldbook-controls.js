const TEXT = {
    en: { title: 'Index worldbook', index: 'Keyword index', content: 'Content columns', primary: 'Primary keyword column',
        separator: 'Literal term separator', enabled: 'Enable chat-local entries', consent: 'Allow selected columns to be sent to the chat model when keywords match',
        preview: 'Preview', sample: 'Local match sample', save: 'Save', disable: 'Disable', close: 'Close', none: 'No keyword indexes',
        saved: 'Saved', disabled: 'Disabled', confirmation: 'Confirm selected data access first', failed: 'Operation refused', count: 'Entries', other: 'Other configured mappings',
        recover: 'Verify saved configuration', recovered: 'Verified. Reopen the editor to continue.', previous: 'Previous configuration restored; the attempted change was not saved.', uncertain: 'Save outcome uncertain. Injection is blocked.' },
    zh_CN: { title: '索引世界书', index: '关键词索引', content: '正文列', primary: '主关键词列',
        separator: '字面关键词分隔符', enabled: '启用聊天内条目', consent: '允许关键词命中时将所选列发送给聊天模型',
        preview: '预览', sample: '本地匹配测试文本', save: '保存', disable: '停用', close: '关闭', none: '没有关键词索引',
        saved: '已保存', disabled: '已停用', confirmation: '请先确认所选数据的外发范围', failed: '操作已拒绝', count: '条目数', other: '其他已配置映射',
        recover: '核验已保存配置', recovered: '核验完成，请重新打开编辑器。', previous: '已恢复原配置，本次改动未保存。', uncertain: '保存结果不确定，注入已阻塞。' },
    zh_TW: { title: '索引世界書', index: '關鍵詞索引', content: '正文欄', primary: '主關鍵詞欄',
        separator: '字面關鍵詞分隔符', enabled: '啟用聊天內條目', consent: '允許關鍵詞命中時將所選欄位傳送給聊天模型',
        preview: '預覽', sample: '本地匹配測試文字', save: '儲存', disable: '停用', close: '關閉', none: '沒有關鍵詞索引',
        saved: '已儲存', disabled: '已停用', confirmation: '請先確認所選資料的外發範圍', failed: '操作已拒絕', count: '條目數', other: '其他已設定映射',
        recover: '核驗已儲存設定', recovered: '核驗完成，請重新開啟編輯器。', previous: '已恢復原設定，本次變更未儲存。', uncertain: '儲存結果不確定，注入已阻塞。' },
};

export function mountIndexWorldbookRecovery(root, { runtime, locale = 'zh_CN' }) {
    const labels = TEXT[locale.replace('-', '_')] || TEXT.en;
    const doc = root.ownerDocument;
    const panel = doc.createElement('section');
    const status = doc.createElement('p'); status.setAttribute('role', 'status');
    status.textContent = labels.uncertain;
    const button = doc.createElement('button'); button.type = 'button'; button.className = 'menu_button';
    button.title = labels.recover; button.setAttribute('aria-label', labels.recover);
    const icon = doc.createElement('i'); icon.className = 'fa-solid fa-rotate'; icon.setAttribute('aria-hidden', 'true');
    button.append(icon);
    let disposed = false, pending = false;
    button.addEventListener('click', async () => {
        if (pending || disposed) return;
        pending = true; button.disabled = true;
        try {
            const receipt = await runtime.recover();
            if (!disposed) status.textContent = receipt.outcome === 'previous' ? labels.previous : labels.recovered;
        } catch (error) {
            if (!disposed) {
                status.textContent = `${labels.failed}: ${/^[A-Z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'INDEX_WORLDBOOK_INVALID'}`;
                button.disabled = false;
            }
        } finally { pending = false; }
    });
    panel.append(status, button); root.append(panel);
    return { element: panel, dispose() { disposed = true; panel.remove(); } };
}

/** Parent supplies a per-table host mount and runtime, not an authority assertion.
 * Returns a disposer. No global styles, inline handlers or HTML from table data. */
export function mountIndexWorldbookControls(root, { runtime, tableId, groupId, locale = 'zh_CN', onClose = () => {}, showClose = true }) {
    if (runtime.getStatus().state === 'stalled') return mountIndexWorldbookRecovery(root, { runtime, locale });
    const doc = root.ownerDocument;
    const labels = TEXT[locale.replace('-', '_')] || TEXT.en;
    let view;
    try { view = runtime.inspect(tableId, groupId); }
    catch (error) {
        // A revoked/readonly mapping can still be removed without exposing table contents.
        try { view = runtime.inspectRemoval(tableId, groupId); }
        catch { throw error; }
    }
    let disposed = false;
    let pending = false;
    let recoveryPanel = null;
    const panel = doc.createElement('section');
    panel.style.cssText = 'display:grid;gap:10px;min-width:0;max-width:640px;width:100%;overflow-wrap:anywhere;text-align:left';
    const title = doc.createElement('h3');
    title.textContent = `${labels.title}: ${view.name}`;
    if (view.removalOnly) {
        const remove = doc.createElement('button');
        remove.type = 'button'; remove.className = 'menu_button'; remove.textContent = labels.disable;
        const status = doc.createElement('output'); status.setAttribute('aria-live', 'polite');
        remove.addEventListener('click', async () => {
            if (pending || disposed) return;
            pending = true; remove.disabled = true;
            try {
                await runtime.disable(view.ticket);
                if (!disposed) status.textContent = labels.disabled;
            } catch (error) {
                if (!disposed) status.textContent = `${labels.failed}: ${/^[A-Z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'INDEX_WORLDBOOK_INVALID'}`;
                if (!disposed && runtime.getStatus().state === 'stalled' && !recoveryPanel) {
                    recoveryPanel = mountIndexWorldbookRecovery(panel, { runtime, locale });
                }
            } finally { pending = false; }
        });
        panel.append(title, remove, status);
        root.append(panel);
        return { element: panel, dispose() { disposed = true; recoveryPanel?.dispose(); panel.remove(); } };
    }
    const index = doc.createElement('select');
    const primary = doc.createElement('select');
    const separator = doc.createElement('input');
    separator.maxLength = 16;
    const sample = doc.createElement('textarea');
    sample.maxLength = 16384; sample.rows = 3;
    const columns = doc.createElement('fieldset');
    const legend = doc.createElement('legend');
    legend.textContent = labels.content;
    columns.append(legend);
    const enabled = doc.createElement('input');
    enabled.type = 'checkbox';
    const consent = doc.createElement('input');
    consent.type = 'checkbox';
    const status = doc.createElement('output');
    status.setAttribute('aria-live', 'polite');
    const result = doc.createElement('pre');
    result.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;min-width:0';
    const toolbar = doc.createElement('div');
    toolbar.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    const other = doc.createElement('details');
    const controls = [];
    function field(text, input) {
        const label = doc.createElement('label');
        const span = doc.createElement('span');
        span.textContent = text;
        label.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0';
        input.setAttribute('aria-label', text);
        input.style.maxWidth = '100%';
        label.append(span, input);
        controls.push(input);
        return label;
    }
    function option(select, value, label) {
        const item = doc.createElement('option');
        item.value = value;
        item.textContent = label;
        select.append(item);
    }
    for (const item of view.indexes) option(index, item.id, item.name);
    if (!view.indexes.length) option(index, '', labels.none);
    const checks = view.columns.map(column => {
        const input = doc.createElement('input');
        input.type = 'checkbox';
        input.value = column.id;
        input.checked = view.binding?.contentColumnIds.includes(column.id) ?? false;
        columns.append(field(column.label, input));
        return input;
    });
    index.value = view.binding?.indexId ?? view.indexes[0]?.id ?? '';
    enabled.checked = view.binding?.enabled === true;
    separator.value = view.binding?.termSeparator ?? '';
    function renderPrimary() {
        primary.replaceChildren();
        for (const id of view.indexes.find(item => item.id === index.value)?.columnIds || []) {
            option(primary, id, view.columns.find(column => column.id === id)?.label ?? id);
        }
    }
    renderPrimary();
    if (view.binding?.primaryColumnId) primary.value = view.binding.primaryColumnId;
    index.addEventListener('change', renderPrimary);
    panel.append(title, field(labels.index, index), columns, field(labels.primary, primary), field(labels.separator, separator),
        field(labels.enabled, enabled), field(labels.consent, consent), field(labels.sample, sample), toolbar, status, result, other);
    function options() {
        return { indexId: index.value, contentColumnIds: checks.filter(item => item.checked).map(item => item.value),
            ...(primary.value ? { primaryColumnId: primary.value } : {}),
            ...(separator.value ? { termSeparator: separator.value } : {}), enabled: enabled.checked };
    }
    function lock(value) {
        pending = value;
        for (const control of controls) control.disabled = value;
    }
    async function perform(action) {
        if (disposed || pending) return;
        lock(true);
        try {
            await action();
        } catch (error) {
            if (!disposed) {
                result.textContent = '';
                status.textContent = `${labels.failed}: ${/^[A-Z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'INDEX_WORLDBOOK_INVALID'}`;
                if (runtime.getStatus().state === 'stalled' && !recoveryPanel) {
                    recoveryPanel = mountIndexWorldbookRecovery(panel, { runtime, locale });
                }
            }
        } finally { if (!disposed && !recoveryPanel) lock(false); }
    }
    function button(icon, name, action) {
        const element = doc.createElement('button');
        element.type = 'button';
        element.className = 'menu_button';
        element.title = name;
        element.setAttribute('aria-label', name);
        const symbol = doc.createElement('i');
        symbol.className = `fa-solid ${icon}`;
        symbol.setAttribute('aria-hidden', 'true');
        element.append(symbol);
        element.addEventListener('click', () => void perform(action));
        toolbar.append(element);
        controls.push(element);
    }
    button('fa-eye', labels.preview, () => {
        const projection = runtime.preview(view.ticket, options(), sample.value);
        status.textContent = `${labels.count}: ${projection.entries.length}`;
        result.textContent = JSON.stringify({ entries: projection.entries.map(entry => ({ primary: entry.key,
            secondary: entry.keysecondary, logic: entry.selectiveLogic, content: entry.content })),
            normalization: projection.diagnostics, matches: projection.sampleMatches }, null, 2);
    });
    button('fa-floppy-disk', labels.save, async () => {
        if (enabled.checked && !consent.checked) { status.textContent = labels.confirmation; return; }
        await runtime.save(view.ticket, options());
        if (disposed) return;
        view = runtime.inspect(tableId, groupId);
        status.textContent = labels.saved;
        consent.checked = false;
        result.textContent = '';
        renderOtherBindings();
    });
    button('fa-ban', labels.disable, async () => {
        await runtime.disable(view.ticket);
        if (disposed) return;
        view = runtime.inspect(tableId, groupId);
        enabled.checked = false;
        consent.checked = false;
        status.textContent = labels.disabled;
        result.textContent = '';
        renderOtherBindings();
    });
    if (showClose) button('fa-xmark', labels.close, () => { dispose(); onClose(); });
    // Changing a destination column/index invalidates an earlier checkbox confirmation.
    panel.addEventListener('change', event => {
        if (event.target !== consent) { consent.checked = false; result.textContent = ''; status.textContent = ''; }
    });
    function renderOtherBindings() {
        other.replaceChildren();
        const summary = doc.createElement('summary'); summary.textContent = labels.other; other.append(summary);
        const bindings = runtime.listBindings().filter(item => item.tableId !== tableId || item.groupId !== groupId);
        other.hidden = bindings.length === 0;
        for (const binding of bindings) {
            const removal = runtime.inspectRemoval(binding.tableId, binding.groupId);
            const row = doc.createElement('div'); row.style.cssText = 'display:flex;gap:8px;align-items:center;overflow-wrap:anywhere';
            const name = doc.createElement('span'); name.textContent = `${binding.groupId} / ${binding.tableId}`;
            const remove = doc.createElement('button'); remove.type = 'button'; remove.className = 'menu_button';
            remove.setAttribute('aria-label', `${labels.disable}: ${binding.tableId}`); remove.title = labels.disable;
            const icon = doc.createElement('i'); icon.className = 'fa-solid fa-ban'; icon.setAttribute('aria-hidden', 'true'); remove.append(icon);
            remove.addEventListener('click', () => void perform(async () => {
                await runtime.disable(removal.ticket);
                if (disposed) return;
                view = runtime.inspect(tableId, groupId);
                status.textContent = labels.disabled;
                result.textContent = ''; consent.checked = false;
                renderOtherBindings();
            }));
            row.append(name, remove); other.append(row);
        }
    }
    renderOtherBindings();
    root.append(panel);
    function dispose() { disposed = true; recoveryPanel?.dispose(); panel.remove(); }
    return { dispose, element: panel };
}

export async function openCurrentIndexWorldbookRecovery() {
    const [{ initializeCurrentIndexWorldbookRuntime }, { callGenericPopup, POPUP_TYPE }, { getLocale }] = await Promise.all([
        import('../../core/table-system/index-worldbook-host.js'), import('/scripts/popup.js'), import('../../utils/i18n/index.js'),
    ]);
    const runtime = await initializeCurrentIndexWorldbookRuntime();
    if (runtime.getStatus().state !== 'stalled') return false;
    const root = document.createElement('div');
    const mounted = mountIndexWorldbookRecovery(root, { runtime, locale: getLocale() });
    try { await callGenericPopup(root, POPUP_TYPE.TEXT, '', { wide: true }); return runtime.getStatus().state === 'recovered'; }
    finally { mounted.dispose(); }
}

export async function openCurrentIndexWorldbook(tableIndex) {
    const [{ getContext }, { getMemoryStateForScope }, { captureChatScope, chatScopesMatch },
        { initializeCurrentIndexWorldbookRuntime }, { callGenericPopup, POPUP_TYPE }, { getLocale }] = await Promise.all([
        import('/scripts/extensions.js'), import('../../core/table-system/manager.js'),
        import('../../core/table-system/infra/chat-scope.js'), import('../../core/table-system/index-worldbook-host.js'),
        import('/scripts/popup.js'), import('../../utils/i18n/index.js'),
    ]);
    const scope = captureChatScope(getContext());
    const tables = getMemoryStateForScope(scope);
    if (!Number.isInteger(tableIndex) || tableIndex < 0 || !tables?.[tableIndex]) return false;
    const { id: tableId, groupId } = tables[tableIndex];
    const runtime = await initializeCurrentIndexWorldbookRuntime();
    if (!chatScopesMatch(scope, captureChatScope(getContext()))) return false;
    const root = document.createElement('div');
    let mounted;
    try {
        mounted = mountIndexWorldbookControls(root, { runtime, tableId, groupId, locale: getLocale(), showClose: false });
    } catch (error) {
        const message = document.createElement('p');
        message.setAttribute('role', 'alert');
        message.textContent = /^[A-Z_]{1,80}$/.test(error?.code ?? '') ? error.code : 'INDEX_WORLDBOOK_UNAVAILABLE';
        root.append(message);
    }
    try { await callGenericPopup(root, POPUP_TYPE.TEXT, '', { wide: true }); return Boolean(mounted); }
    finally { mounted?.dispose(); }
}
