import * as api from '../../../api.js';
import { fail } from '../validation.js';

// callAIWithConnection owns and sanitizes these codes; never copy provider details.
const CONNECTION_ERRORS = Object.freeze({
    EXPLICIT_CONNECTION_INPUT_INVALID: 'FILL_CONNECTION_INPUT_INVALID',
    EXPLICIT_CONNECTION_MESSAGES_INVALID: 'FILL_CONNECTION_MESSAGES_INVALID',
    EXPLICIT_CONNECTION_REF_INVALID: 'FILL_CONNECTION_REF_INVALID',
    EXPLICIT_CONNECTION_PROFILE_INVALID: 'FILL_CONNECTION_PROFILE_INVALID',
    EXPLICIT_CONNECTION_PRESET_UNSUPPORTED: 'FILL_CONNECTION_PRESET_UNSUPPORTED',
    EXPLICIT_CONNECTION_PROVIDER_UNSUPPORTED: 'FILL_CONNECTION_PROVIDER_UNSUPPORTED',
    EXPLICIT_CONNECTION_OVERRIDES_INVALID: 'FILL_CONNECTION_OVERRIDES_INVALID',
    EXPLICIT_CONNECTION_MODEL_MISMATCH: 'FILL_CONNECTION_MODEL_MISMATCH',
    EXPLICIT_CONNECTION_PROFILE_CHANGED: 'FILL_CONNECTION_PROFILE_CHANGED',
    EXPLICIT_CONNECTION_DISABLED: 'FILL_CONNECTION_DISABLED',
    EXPLICIT_CONNECTION_GUARD_REQUIRED: 'FILL_CONNECTION_GUARD_REQUIRED',
    EXPLICIT_CONNECTION_GUARD_REJECTED: 'FILL_CONNECTION_GUARD_REJECTED',
    EXPLICIT_CONNECTION_KEY_MISSING: 'FILL_CONNECTION_KEY_MISSING',
    EXPLICIT_CONNECTION_RESPONSE_INVALID: 'FILL_CONNECTION_RESPONSE_INVALID',
    EXPLICIT_CONNECTION_RESPONSE_INCOMPLETE: 'FILL_CONNECTION_RESPONSE_INCOMPLETE',
    EXPLICIT_CONNECTION_RESPONSE_TOO_LARGE: 'FILL_CONNECTION_RESPONSE_TOO_LARGE',
    EXPLICIT_CONNECTION_RESPONSE_READ_FAILED: 'FILL_CONNECTION_RESPONSE_READ_FAILED',
    EXPLICIT_CONNECTION_RESPONSE_EMPTY: 'FILL_CONNECTION_RESPONSE_EMPTY',
    EXPLICIT_CONNECTION_REQUEST_FAILED: 'FILL_CONNECTION_REQUEST_FAILED',
});

export function estimateFillInputBudget(messages) {
    // Conservative UTF-8 content bound plus framing reserve; never reported provider usage.
    return new TextEncoder().encode(JSON.stringify(messages)).length + 256 + messages.length * 16;
}

export function validateFillModelResponse(response, profile) {
    if (!response || response.connectionRef !== profile.connectionRef
        || typeof response.text !== 'string' || !response.text.trim()) fail('FILL_RESPONSE_MISSING');
    if (response.complete !== true || response.truncated === true || !['stop', 'end_turn', 'STOP'].includes(response.finishReason)) fail('FILL_RESPONSE_INCOMPLETE');
    const bytes = new TextEncoder().encode(response.text).length;
    if (bytes > 1024 * 1024) fail('FILL_RESPONSE_LIMIT');
    const usage = response.usage;
    if (usage !== null && usage !== undefined) {
        for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
            if (usage[field] !== undefined && (!Number.isSafeInteger(usage[field]) || usage[field] < 0)) fail('FILL_RESPONSE_BUDGET');
        }
        if (usage.completion_tokens > profile.outputTokenBudget || usage.prompt_tokens > profile.inputTokenBudget) fail('FILL_RESPONSE_BUDGET');
    }
    // UTF-8 bytes are a conservative tokenizer-independent upper bound, not reported usage.
    if (usage?.completion_tokens === undefined && bytes > profile.outputTokenBudget) fail('FILL_RESPONSE_BUDGET');
    return response.text;
}

export async function requestFillModelResult({ profile, messages, signal, beforeSend }, call = api.callAIWithConnection) {
    if (typeof call !== 'function') fail('FILL_CONNECTION_API_UNAVAILABLE');
    if (estimateFillInputBudget(messages) > profile.inputTokenBudget) fail('FILL_INPUT_BUDGET');
    let checked = false;
    const guard = async stage => {
        if (signal?.aborted) fail('FILL_CANCELLED');
        await beforeSend(stage);
        if (signal?.aborted) fail('FILL_CANCELLED');
        checked = true;
        return true;
    };
    let response;
    try {
        response = await call({ connectionRef: profile.connectionRef, messages,
            overrides: { model: profile.model, maxTokens: profile.outputTokenBudget,
                ...(profile.parameters.temperature === undefined ? {} : { temperature: profile.parameters.temperature }),
                ...(profile.parameters.topP === undefined ? {} : { top_p: profile.parameters.topP }) },
            signal, beforeSend: guard });
    } catch (error) {
        const code = error?.code;
        if (code === 'EXPLICIT_CONNECTION_REQUEST_FAILED'
            && Number.isInteger(error.status) && error.status >= 400 && error.status <= 599) {
            fail(`FILL_CONNECTION_HTTP_${error.status}`);
        }
        if (typeof code === 'string' && Object.hasOwn(CONNECTION_ERRORS, code)) fail(CONNECTION_ERRORS[code]);
        throw error;
    }
    if (!checked) fail('FILL_SEND_GUARD_MISSING');
    await guard();
    const text = validateFillModelResponse(response, profile);
    return Object.freeze({ text, complete: true, finishReason: response.finishReason, truncated: false });
}

export async function requestFillModel(options, call) {
    return (await requestFillModelResult(options, call)).text;
}
