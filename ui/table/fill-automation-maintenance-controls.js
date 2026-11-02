export function createFillAutomationMaintenanceControls({ document, runtime, tableId, label, confirmAction, onError }) {
    const element = document.createElement('fieldset'); element.style.gridColumn = '1 / -1'; element.style.minWidth = '0';
    const legend = document.createElement('legend'); legend.textContent = label('maintenance'); element.append(legend);
    const state = document.createElement('output'); element.append(state);
    const feedback = document.createElement('output'); feedback.setAttribute('role', 'status'); feedback.setAttribute('aria-live', 'polite'); element.append(feedback);
    const select = document.createElement('select'); select.style.maxWidth = '100%'; select.setAttribute('aria-label', label('task')); element.append(select);
    const details = document.createElement('pre'); details.style.whiteSpace = 'pre-wrap'; details.style.overflowWrap = 'anywhere'; element.append(details);
    let disposed = false;
    let busy = false;
    let snapshot;
    const listeners = [];
    const buttons = [];
    const listen = (node, event, action) => { node.addEventListener(event, action); listeners.push(() => node.removeEventListener(event, action)); };
    const inspect = () => {
        const item = (snapshot?.tasks ?? []).find(task => task.taskId === select.value);
        details.textContent = item ? [label(`status.${item.status}`), `${label('attempts')}: ${item.attempts}`,
            `${label('range')}: ${item.positions?.map(position => position + 1).join(', ') || '-'}`,
            `${label('candidate')}: ${label(item.hasCandidate ? 'yes' : 'no')}`, item.errorCode || ''].join('\n') : '';
    };
    const refresh = () => {
        if (disposed) return;
        const selected = select.value;
        snapshot = runtime.getState(); select.replaceChildren();
        state.textContent = `${label('requestsUsed')}: ${snapshot.requestsUsed ?? 0}; ${label('tokensReserved')}: ${snapshot.tokensReserved ?? 0}`;
        for (const [index, task] of (snapshot.tasks ?? []).filter(task => task.tableIds?.includes(tableId)).entries()) {
            const option = document.createElement('option'); option.value = task.taskId;
            option.textContent = `${index + 1}: ${label(`status.${task.status}`)}`; select.append(option);
        }
        if ([...select.options].some(option => option.value === selected)) select.value = selected;
        inspect();
    };
    const reportError = error => {
        if (disposed) return;
        const code = error?.code ?? error?.message;
        const key = code === 'FILL_UI_TARGET_CHANGED' ? 'maintenanceTargetChanged'
                : /^(TABLE_WRITE_|FILL_RECOVERY_|FILL_RECONCILIATION_REQUIRED)/.test(code ?? '') ? 'maintenanceFrozen' : 'failed';
        feedback.textContent = label(key);
        onError?.(error);
    };
    const command = async action => {
        if (disposed || busy) return;
        busy = true; select.disabled = true; feedback.textContent = ''; buttons.forEach(button => { button.disabled = true; });
        try { await action(); }
        catch (error) { reportError(error); }
        finally {
            busy = false;
            if (!disposed) {
                try { refresh(); } catch (error) { reportError(error); }
                select.disabled = false; buttons.forEach(button => { button.disabled = false; });
            }
        }
    };
    const button = (key, icon, action) => {
        const node = document.createElement('button'); node.type = 'button'; node.className = 'menu_button';
        node.title = label(key); node.setAttribute('aria-label', label(key));
        const glyph = document.createElement('i'); glyph.className = `fas fa-${icon}`; glyph.setAttribute('aria-hidden', 'true'); node.append(glyph);
        element.append(node); buttons.push(node); listen(node, 'click', () => command(action));
    };
    const confirm = async (action, extra) => {
        const captured = runtime.load(tableId);
        const before = JSON.stringify(runtime.getState());
        const approved = await confirmAction({ action, details: extra });
        if (disposed) throw new Error('FILL_UI_TARGET_CHANGED');
        const live = runtime.load(tableId);
        if (disposed || live.targetId !== captured.targetId || live.config.revision !== captured.config.revision
            || JSON.stringify(runtime.getState()) !== before) throw new Error('FILL_UI_TARGET_CHANGED');
        if (approved !== true) feedback.textContent = label('maintenanceCancelled');
        return approved === true;
    };
    const completed = (result, key = 'maintenanceDone') => {
        if (!disposed) feedback.textContent = label(result === false ? 'maintenanceUnchanged' : key);
    };
    button('refreshTasks', 'sync', refresh);
    button('verifyPersistence', 'magnifying-glass', async () => {
        if (await confirm('verifyPersistence', [label('verifyWarning')])) {
            const result = await runtime.reconcilePersistence({ confirmed: true });
            const key = result?.status === 'verified-committed' ? 'maintenanceCommitted'
                : result?.status === 'verified-not-committed' ? 'maintenanceNotCommitted'
                    : result?.status === 'none' ? 'maintenanceNoRecovery' : 'maintenanceFrozen';
            completed(result, key);
        }
    });
    button('reconcileTask', 'clipboard-check', async () => {
        const task = (snapshot.tasks ?? []).find(item => item.taskId === select.value);
        if (!task || !['running', 'candidate', 'needs-review'].includes(task.status)) throw new Error('FILL_RECONCILIATION_REQUIRED');
        if (await confirm('reconcileTask', [label('reconcileWarning'), details.textContent])) {
            completed(await runtime.reconcileUnit({ unitId: task.taskId, outcome: 'not-committed', confirmed: true }), 'maintenanceCandidate');
        }
    });
    button('resetBudget', 'rotate-left', async () => {
        if (await confirm('resetBudget', [label('budgetWarning'), state.textContent])) completed(await runtime.resetBudget({ confirmed: true }));
    });
    button('restoreSummary', 'clock-rotate-left', async () => {
        const task = (snapshot.tasks ?? []).find(item => item.taskId === select.value);
        if (!task?.canRestore) throw new Error('FILL_RESTORE_UNAVAILABLE');
        if (await confirm('restoreSummary', [label('restoreWarning'), details.textContent])) {
            completed(await runtime.restoreCompaction({ unitId: task.taskId, confirmed: true }));
        }
    });
    button('cleanupLedger', 'broom', async () => {
        if (await confirm('cleanupLedger', [label('cleanupWarning')])) completed(await runtime.cleanupLedger({ confirmed: true }));
    });
    listen(select, 'change', inspect);
    refresh();
    return { element, refresh, dispose() { disposed = true; listeners.forEach(remove => remove()); } };
}
