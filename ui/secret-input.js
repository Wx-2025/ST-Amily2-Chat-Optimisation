const STORED_SECRET_PLACEHOLDER = '已安全保存；输入新值可替换';

function resolveInput(input) {
    if (!input) return null;
    if (input.jquery) return input[0] ?? null;
    return input;
}

/**
 * Keep a saved credential out of the DOM while preserving a useful UI state.
 * The actual value remains in ConfigManager and is read only when a request is made.
 */
export function clearSecretInput(input, hasStoredSecret, emptyPlaceholder) {
    const element = resolveInput(input);
    if (!element) return;

    const fallbackPlaceholder = emptyPlaceholder || element.dataset.emptySecretPlaceholder || element.placeholder || '请输入 API Key';
    element.dataset.emptySecretPlaceholder = fallbackPlaceholder;
    element.value = '';
    element.autocomplete = 'new-password';
    element.dataset.secretStored = hasStoredSecret ? 'true' : 'false';
    element.dataset.secretDirty = 'false';
    if (element.dataset.secretInputBound !== 'true' && typeof element.addEventListener === 'function') {
        element.addEventListener('input', () => {
            element.dataset.secretDirty = 'true';
        });
        element.dataset.secretInputBound = 'true';
    }
    element.placeholder = hasStoredSecret ? STORED_SECRET_PLACEHOLDER : fallbackPlaceholder;
}

/**
 * An empty field with secretStored=true means "leave the saved value unchanged".
 * Explicit clear actions must continue to clear ConfigManager directly.
 */
export function readSecretInputUpdate(input) {
    const element = resolveInput(input);
    if (!element) return { changed: false, value: '' };

    const value = String(element.value ?? '').trim();
    if (!value && element.dataset.secretStored === 'true' && element.dataset.secretDirty !== 'true') {
        return { changed: false, value: '' };
    }

    return { changed: true, value };
}

export function markSecretInputStored(input, hasStoredSecret) {
    const element = resolveInput(input);
    if (!element) return;
    clearSecretInput(element, hasStoredSecret);
}

