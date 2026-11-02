const PREFIX = 'EXPLICIT_CONNECTION_';
const ownedErrors = new WeakSet();
const SAFE_FINISH_REASONS = new Set(['stop', 'length', 'content_filter', 'tool_calls',
    'function_call', 'STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER']);

export function explicitConnectionError(suffix) {
    const error = Object.assign(new Error('Explicit model request rejected.'), { code: PREFIX + suffix });
    ownedErrors.add(error);
    return error;
}

export function isExplicitConnectionError(error) { return ownedErrors.has(error); }

// Profile metadata is local configuration, but may originate in an imported
// settings file. Do not invoke getters/toJSON or accept unbounded/cyclic data.
export function snapshotModelData(value, maxChars = 1024 * 1024) {
    let nodes = 0;
    let chars = 0;
    const seen = new Set();
    const visit = (input, depth) => {
        if (++nodes > 20000 || depth > 16) throw explicitConnectionError('INPUT_INVALID');
        if (input === null || typeof input === 'boolean') return input;
        if (typeof input === 'string') {
            chars += input.length;
            if (chars > maxChars) throw explicitConnectionError('INPUT_INVALID');
            return input;
        }
        if (typeof input === 'number' && Number.isFinite(input)) return input;
        if (!input || typeof input !== 'object' || seen.has(input)) throw explicitConnectionError('INPUT_INVALID');
        seen.add(input);
        const output = Array.isArray(input) ? [] : {};
        const keys = Object.keys(input).sort();
        if (Array.isArray(input) && keys.length !== input.length) throw explicitConnectionError('INPUT_INVALID');
        for (const key of keys) {
            const property = Object.getOwnPropertyDescriptor(input, key);
            if (!property || !Object.hasOwn(property, 'value') || ['__proto__', 'constructor', 'prototype'].includes(key)) {
                throw explicitConnectionError('INPUT_INVALID');
            }
            chars += key.length;
            if (chars > maxChars) throw explicitConnectionError('INPUT_INVALID');
            output[key] = visit(property.value, depth + 1);
        }
        seen.delete(input);
        return Object.freeze(output);
    };
    return visit(value, 0);
}

export function snapshotExplicitMessages(messages) {
    const copy = snapshotModelData(messages);
    if (!Array.isArray(copy) || copy.length === 0 || copy.length > 2048
        || copy.some(message => !message || !['system', 'user', 'assistant'].includes(message.role)
            || typeof message.content !== 'string'
            || Object.keys(message).some(key => !['role', 'content'].includes(key)))) {
        throw explicitConnectionError('MESSAGES_INVALID');
    }
    return copy;
}

export function explicitConnectionMetadata(manager, connectionRef) {
    if (typeof connectionRef !== 'string' || !connectionRef || connectionRef.length > 128) {
        throw explicitConnectionError('REF_INVALID');
    }
    const profile = manager.getProfile(connectionRef);
    if (!profile || profile.type !== 'chat' || profile.connectionSourceMissing) {
        throw explicitConnectionError('PROFILE_INVALID');
    }
    if (profile.provider === 'sillytavern_preset') throw explicitConnectionError('PRESET_UNSUPPORTED');
    if (!['openai', 'google', 'anthropic', 'sillytavern_backend', 'custom', 'deepseek', 'openrouter', 'xai',
        'qwen', 'custom_oai', 'openai_test'].includes(profile.provider)) {
        throw explicitConnectionError('PROVIDER_UNSUPPORTED');
    }
    let url;
    try { url = new URL(profile.apiUrl); } catch { throw explicitConnectionError('PROFILE_INVALID'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash
        || url.search || typeof profile.model !== 'string' || !profile.model.trim()) {
        throw explicitConnectionError('PROFILE_INVALID');
    }
    return snapshotModelData(profile, 65536);
}

export function normalizeExplicitOverrides(overrides = {}, model) {
    const copy = snapshotModelData(overrides, 16384);
    if (!copy || Array.isArray(copy) || typeof copy !== 'object'
        || Object.keys(copy).some(key => !['model', 'maxTokens', 'temperature', 'top_p'].includes(key))) {
        throw explicitConnectionError('OVERRIDES_INVALID');
    }
    for (const [key, value] of Object.entries(copy)) {
        if (key === 'model') {
            if (value !== model) throw explicitConnectionError('MODEL_MISMATCH');
            continue;
        }
        const max = key === 'maxTokens' ? 131072 : key === 'temperature' ? 2 : 1;
        const min = key === 'maxTokens' ? 1 : 0;
        if (typeof value !== 'number' || value < min || value > max
            || (key === 'maxTokens' && !Number.isSafeInteger(value))) throw explicitConnectionError('OVERRIDES_INVALID');
    }
    return copy;
}

export function explicitResponseEvidence(raw, text, provider) {
    const data = raw?.data?.choices ? raw.data : raw;
    const choices = provider === 'google' ? data?.candidates : data?.choices;
    const choice = Array.isArray(choices) && choices.length === 1 ? choices[0] : null;
    const rawReason = provider === 'google' ? choice?.finishReason : choice?.finish_reason;
    const finishReason = SAFE_FINISH_REASONS.has(rawReason) ? rawReason : null;
    const usage = {};
    const source = data?.usage ?? data?.usageMetadata;
    for (const [target, keys] of Object.entries({
        prompt_tokens: ['prompt_tokens', 'promptTokenCount'],
        completion_tokens: ['completion_tokens', 'candidatesTokenCount'],
        total_tokens: ['total_tokens', 'totalTokenCount'],
    })) {
        const value = keys.map(key => source?.[key]).find(value => Number.isSafeInteger(value) && value >= 0);
        if (value !== undefined) usage[target] = value;
    }
    return Object.freeze({
        text: typeof text === 'string' ? text : '',
        content: typeof text === 'string' ? text : '',
        finishReason,
        usage: Object.keys(usage).length ? Object.freeze(usage) : null,
        complete: typeof text === 'string' && text.trim().length > 0 && !data?.error
            && (finishReason === 'stop' || finishReason === 'STOP')
            && !choice?.message?.tool_calls?.length && !choice?.message?.function_call,
    });
}
