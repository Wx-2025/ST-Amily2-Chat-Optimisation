const OPEN_REVIEW_EVENT = 'amily2:openTableFillReview';
const PROGRESS_CHANGED_EVENT = 'amily2:secondaryFillProgressChanged';

const controllers = new WeakMap();

/**
 * Bind the table-fill review inbox without importing the filler runtime here.
 * The table panel owns dependency injection so this UI module cannot create a
 * secondary-filler <-> table-bindings import cycle of its own.
 */
export function bindTableFillReviewControls(panel, dependencies = {}) {
    if (!panel) return null;

    const existing = controllers.get(panel);
    if (existing) {
        existing.updateDependencies(dependencies);
        void existing.refresh();
        return existing;
    }

    const elements = resolveElements(panel);
    if (!elements) return null;

    const state = {
        panel,
        elements,
        dependencies: normalizeDependencies(dependencies),
        records: [],
        drafts: new Map(),
        actionMessages: new Map(),
        busyReviewIds: new Set(),
        selectedReviewId: null,
        refreshRevision: 0,
    };

    const controller = createController(state);
    controllers.set(panel, controller);
    controller.bind();
    void controller.refresh();
    return controller;
}

function createController(state) {
    const { panel, elements } = state;

    const updateDependencies = dependencies => {
        state.dependencies = normalizeDependencies(dependencies);
    };

    const refresh = async ({ focusReviewId = state.selectedReviewId } = {}) => {
        const revision = ++state.refreshRevision;
        setListBusy(elements, true);
        try {
            const result = await Promise.resolve(state.dependencies.listReviews());
            if (revision !== state.refreshRevision) return;
            state.records = Array.isArray(result) ? result : [];
            pruneDrafts(state);
            renderReviewInbox(state);
            if (focusReviewId) focusReviewCard(state, focusReviewId);
        } catch (error) {
            if (revision !== state.refreshRevision) return;
            renderLoadFailure(state, error);
        } finally {
            if (revision === state.refreshRevision) setListBusy(elements, false);
        }
    };

    const open = reviewId => {
        const normalizedId = normalizeReviewId(reviewId);
        state.selectedReviewId = normalizedId;

        ensureMainDrawerOpen();
        const openPanelButton = document.getElementById('amily2_open_memorisation_forms');
        if (!isElementVisible(panel) && openPanelButton) {
            openPanelButton.click();
        }

        elements.navButton.click();
        void refresh({ focusReviewId: normalizedId });
    };

    const bind = () => {
        elements.navButton.addEventListener('click', () => {
            void refresh();
        });

        const openPanelButton = document.getElementById('amily2_open_memorisation_forms');
        openPanelButton?.addEventListener('click', () => {
            setTimeout(() => {
                if (isElementVisible(panel)) void refresh();
            }, 0);
        });

        document.addEventListener(OPEN_REVIEW_EVENT, event => {
            open(event?.detail?.reviewId);
        });
        document.addEventListener(PROGRESS_CHANGED_EVENT, () => {
            void refresh();
        });
    };

    return Object.freeze({
        bind,
        open,
        refresh,
        updateDependencies,
    });
}

function normalizeDependencies(dependencies) {
    const listReviews = typeof dependencies?.listReviews === 'function'
        ? dependencies.listReviews
        : () => [];
    const applyReview = typeof dependencies?.applyReview === 'function'
        ? dependencies.applyReview
        : async () => {
            throw new Error('错误审查的“编辑后应用”接口尚未就绪。');
        };
    const retryReview = typeof dependencies?.retryReview === 'function'
        ? dependencies.retryReview
        : async () => {
            throw new Error('错误审查的“重新填表”接口尚未就绪。');
        };
    return Object.freeze({ listReviews, applyReview, retryReview });
}

function resolveElements(panel) {
    const navButton = panel.querySelector('.sinan-nav-item[data-tab="fill-review"]');
    const pane = panel.querySelector('#sinan-fill-review-tab');
    const list = panel.querySelector('#amily2-fill-review-list');
    const summary = panel.querySelector('#amily2-fill-review-summary');
    const badge = panel.querySelector('#amily2-fill-review-count-badge');
    if (!navButton || !pane || !list || !summary || !badge) return null;
    return Object.freeze({ navButton, pane, list, summary, badge });
}

function renderReviewInbox(state) {
    const { elements, records } = state;
    elements.list.replaceChildren();
    elements.badge.textContent = String(records.length);
    elements.badge.hidden = records.length === 0;
    elements.navButton.classList.toggle('has-unresolved', records.length > 0);
    elements.summary.textContent = records.length > 0
        ? `当前聊天有 ${records.length} 条待处理记录`
        : '当前聊天没有待处理记录';

    if (records.length === 0) {
        elements.list.append(createTextElement(
            elements.list.ownerDocument,
            'div',
            'amily2-fill-review-empty',
            '当前聊天没有待处理的填表错误。',
        ));
        return;
    }

    for (const record of records) {
        elements.list.append(createReviewCard(state, record));
    }
}

function createReviewCard(state, record) {
    const doc = state.elements.list.ownerDocument;
    const reviewId = normalizeReviewId(record?.id);
    const card = doc.createElement('article');
    card.className = 'amily2-fill-review-card';
    card.dataset.reviewId = reviewId || '';
    if (reviewId && state.selectedReviewId === reviewId) {
        card.classList.add('is-selected');
    }

    const details = doc.createElement('details');
    details.className = 'amily2-fill-review-details';
    details.open = Boolean(reviewId && state.selectedReviewId === reviewId);
    const summary = doc.createElement('summary');
    summary.className = 'amily2-fill-review-card-summary';
    summary.append(
        createTextElement(
            doc,
            'span',
            'amily2-fill-review-card-title',
            `${formatFloors(record?.floors)} · ${formatSource(record?.source)}`,
        ),
        createTextElement(
            doc,
            'span',
            `amily2-fill-review-status is-${safeStatus(record?.status)}`,
            formatStatus(record),
        ),
    );
    details.append(summary);

    const body = doc.createElement('div');
    body.className = 'amily2-fill-review-card-body';
    body.append(createReviewMetadata(doc, record), createReviewError(doc, record));

    if (record?.volatile === true) {
        body.append(createTextElement(
            doc,
            'div',
            'amily2-fill-review-warning',
            '这条记录当前只保存在本次会话内；重新载入聊天后可能无法恢复。',
        ));
    }
    if (record?.responseTruncated === true) {
        body.append(createTextElement(
            doc,
            'div',
            'amily2-fill-review-warning',
            `原始响应过长，存档仅保留了部分内容（原长度 ${formatInteger(record.responseOriginalLength)}）。请重新填表。`,
        ));
    }
    if (record?.conflictReason) {
        body.append(createTextElement(
            doc,
            'div',
            'amily2-fill-review-conflict',
            String(record.conflictReason),
        ));
    }

    const editorLabel = createTextElement(
        doc,
        'label',
        'amily2-fill-review-editor-label',
        '模型原始响应 / 修复文本',
    );
    const textarea = doc.createElement('textarea');
    textarea.className = 'text_pole amily2-fill-review-editor';
    textarea.spellcheck = false;
    textarea.wrap = 'off';
    const draft = reviewId ? state.drafts.get(reviewId) : undefined;
    textarea.value = draft !== undefined
        ? draft
        : String(record?.responseText ?? '');
    const editable = record?.editable === true && record?.responseTruncated !== true;
    const busy = Boolean(reviewId && state.busyReviewIds.has(reviewId));
    textarea.readOnly = !editable || busy;
    textarea.placeholder = record?.legacy === true
        ? '旧版本失败锁没有保存模型原始响应。'
        : '没有可显示的模型响应。';
    editorLabel.append(textarea);
    body.append(editorLabel);

    if (reviewId && editable) {
        textarea.addEventListener('input', () => {
            state.drafts.set(reviewId, textarea.value);
        });
    }

    const actionStatus = createTextElement(
        doc,
        'div',
        'amily2-fill-review-action-status',
        reviewId ? state.actionMessages.get(reviewId) ?? '' : '',
    );
    actionStatus.setAttribute('role', 'status');
    actionStatus.setAttribute('aria-live', 'polite');

    const actions = doc.createElement('div');
    actions.className = 'amily2-fill-review-actions';
    const applyButton = createActionButton(
        doc,
        '编辑后应用',
        'fas fa-check',
        'menu_button menu_button_primary interactable',
    );
    const retryButton = createActionButton(
        doc,
        '重新填表',
        'fas fa-redo',
        'menu_button secondary interactable',
    );
    applyButton.disabled = busy || !reviewId || !editable;
    retryButton.disabled = busy || !reviewId || record?.retryable !== true;

    applyButton.addEventListener('click', () => {
        void runReviewAction(state, {
            card,
            reviewId,
            action: 'apply',
            editedText: textarea.value,
            statusElement: actionStatus,
        });
    });
    retryButton.addEventListener('click', () => {
        void runReviewAction(state, {
            card,
            reviewId,
            action: 'retry',
            statusElement: actionStatus,
        });
    });
    actions.append(applyButton, retryButton);
    body.append(actionStatus, actions);
    details.append(body);
    card.append(details);
    return card;
}

async function runReviewAction(
    state,
    {
        card,
        reviewId,
        action,
        editedText = '',
        statusElement,
    },
) {
    if (!reviewId || state.busyReviewIds.has(reviewId)) return;
    state.busyReviewIds.add(reviewId);
    state.selectedReviewId = reviewId;
    state.actionMessages.delete(reviewId);
    setCardBusy(card, true);
    statusElement.textContent = action === 'apply'
        ? '正在严格校验并保存修复…'
        : '正在重新请求填表…';

    try {
        if (action === 'apply') {
            state.drafts.set(reviewId, editedText);
            await state.dependencies.applyReview(reviewId, editedText);
            state.drafts.delete(reviewId);
            notify('success', '修复已通过校验并保存。');
        } else {
            const outcome = await state.dependencies.retryReview(reviewId);
            if (outcome?.resolved === false) {
                notify('warning', '重新填表仍需处理，错误记录已更新。');
            } else {
                state.drafts.delete(reviewId);
                notify('success', '重新填表已完成。');
            }
        }
        state.actionMessages.delete(reviewId);
    } catch (error) {
        const message = String(error?.message || '操作失败，错误记录仍保留。');
        state.actionMessages.set(reviewId, message);
        statusElement.textContent = message;
        notify('error', '操作失败，详情和修复文本仍保留在错误审查中。');
    } finally {
        state.busyReviewIds.delete(reviewId);
        setCardBusy(card, false);
        await refreshController(state, reviewId);
    }
}

async function refreshController(state, reviewId) {
    const controller = controllers.get(state.panel);
    if (!controller) return;
    await controller.refresh({ focusReviewId: reviewId });
}

function createReviewMetadata(doc, record) {
    const meta = doc.createElement('div');
    meta.className = 'amily2-fill-review-meta';
    const createdAt = formatTimestamp(record?.createdAt);
    const attempts = Math.max(0, Number.parseInt(record?.attempts, 10) || 0);
    meta.append(
        createTextElement(doc, 'span', '', `记录时间：${createdAt}`),
        createTextElement(doc, 'span', '', `尝试次数：${attempts}`),
    );
    return meta;
}

function createReviewError(doc, record) {
    const block = doc.createElement('div');
    block.className = 'amily2-fill-review-error';
    const error = record?.error && typeof record.error === 'object'
        ? record.error
        : {};
    const code = String(error.code || 'TABLE_FILL_REVIEW_REQUIRED');
    const line = Number.isSafeInteger(error.line) ? ` · 第 ${error.line} 行` : '';
    block.append(
        createTextElement(doc, 'div', 'amily2-fill-review-error-code', `${code}${line}`),
        createTextElement(
            doc,
            'div',
            'amily2-fill-review-error-message',
            String(error.message || '填表结果未通过校验。'),
        ),
    );
    return block;
}

function createActionButton(doc, text, iconClass, className) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = className;
    const icon = doc.createElement('i');
    icon.className = iconClass;
    button.append(icon, doc.createTextNode(` ${text}`));
    return button;
}

function createTextElement(doc, tagName, className, text) {
    const element = doc.createElement(tagName);
    if (className) element.className = className;
    element.textContent = String(text ?? '');
    return element;
}

function setListBusy(elements, busy) {
    elements.list.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function setCardBusy(card, busy) {
    card.classList.toggle('is-busy', busy);
    card.querySelectorAll('button, textarea').forEach(control => {
        if (busy) {
            control.dataset.reviewPriorDisabled = control.disabled ? 'true' : 'false';
            control.dataset.reviewPriorReadOnly = control.readOnly ? 'true' : 'false';
            if (control.tagName === 'BUTTON') control.disabled = true;
            if (control.tagName === 'TEXTAREA') control.readOnly = true;
            return;
        }
        if (control.tagName === 'BUTTON') {
            control.disabled = control.dataset.reviewPriorDisabled === 'true';
        }
        if (control.tagName === 'TEXTAREA') {
            control.readOnly = control.dataset.reviewPriorReadOnly === 'true';
        }
        delete control.dataset.reviewPriorDisabled;
        delete control.dataset.reviewPriorReadOnly;
    });
}

function renderLoadFailure(state, error) {
    const { elements } = state;
    elements.badge.textContent = '0';
    elements.badge.hidden = true;
    elements.navButton.classList.remove('has-unresolved');
    elements.list.replaceChildren(createTextElement(
        elements.list.ownerDocument,
        'div',
        'amily2-fill-review-load-error',
        `读取错误审查记录失败：${error?.message || error}`,
    ));
    elements.summary.textContent = '读取记录失败';
}

function focusReviewCard(state, reviewId) {
    const normalizedId = normalizeReviewId(reviewId);
    if (!normalizedId) return;
    const card = [...state.elements.list.querySelectorAll('.amily2-fill-review-card')]
        .find(candidate => candidate.dataset.reviewId === normalizedId);
    if (!card) return;
    card.classList.add('is-selected');
    const details = card.querySelector('details');
    if (details) details.open = true;
    const scheduleFrame = typeof globalThis.requestAnimationFrame === 'function'
        ? callback => globalThis.requestAnimationFrame(callback)
        : callback => setTimeout(callback, 0);
    scheduleFrame(() => {
        card.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
        const textarea = card.querySelector('textarea:not([readonly])');
        try {
            textarea?.focus({ preventScroll: true });
        } catch {
            textarea?.focus();
        }
    });
}

function pruneDrafts(state) {
    const liveIds = new Set(state.records
        .map(record => normalizeReviewId(record?.id))
        .filter(Boolean));
    for (const reviewId of state.drafts.keys()) {
        if (!liveIds.has(reviewId)) state.drafts.delete(reviewId);
    }
    for (const reviewId of state.actionMessages.keys()) {
        if (!liveIds.has(reviewId)) state.actionMessages.delete(reviewId);
    }
}

function formatFloors(floors) {
    const normalized = Array.isArray(floors)
        ? floors.filter(Number.isSafeInteger)
        : [];
    if (normalized.length === 0) return '未知楼层';
    if (normalized.length === 1) return `第 ${normalized[0]} 楼`;
    return `第 ${normalized.join('、')} 楼`;
}

function formatSource(source) {
    const normalized = String(source || '').toLowerCase();
    if (normalized.includes('legacy')) return '历史失败锁';
    if (normalized.includes('secondary')) return '分步填表';
    if (normalized.includes('floor')) return '楼层填表';
    if (normalized.includes('batch')) return '批量填表';
    return '填表任务';
}

function formatStatus(record) {
    if (record?.volatile === true) return '仅本次会话';
    if (record?.status === 'stale') return '证据已变化';
    if (record?.legacy === true) return '历史锁';
    return '等待处理';
}

function safeStatus(status) {
    return status === 'stale' ? 'stale' : 'pending';
}

function formatTimestamp(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return '未知';
    try {
        return new Date(numeric).toLocaleString();
    } catch {
        return '未知';
    }
}

function formatInteger(value) {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && numeric >= 0
        ? numeric.toLocaleString()
        : '未知';
}

function normalizeReviewId(value) {
    const normalized = String(value ?? '').trim();
    return normalized || null;
}

function ensureMainDrawerOpen() {
    const drawerContent = document.getElementById('amily2_drawer_content');
    if (!drawerContent?.classList.contains('closedDrawer')) return;
    const drawerToggle = document.querySelector('#amily2_main_drawer .drawer-toggle');
    drawerToggle?.click();
}

function isElementVisible(element) {
    if (!element?.isConnected) return false;
    const view = element.ownerDocument?.defaultView;
    for (let current = element; current; current = current.parentElement) {
        if (current.hidden || current.style?.display === 'none') return false;
        if (typeof view?.getComputedStyle === 'function') {
            const style = view.getComputedStyle(current);
            if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
    }
    return true;
}

function notify(level, message) {
    const toaster = globalThis.toastr;
    if (toaster && typeof toaster[level] === 'function') {
        toaster[level](message, '填表错误审查');
        return;
    }
    const logger = level === 'error' ? console.error : console.log;
    logger(`[Amily2-错误审查] ${message}`);
}
