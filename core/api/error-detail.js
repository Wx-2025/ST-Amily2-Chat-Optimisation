const MAX_BYTES = 64 * 1024;
const MAX_DETAIL = 4000;
const OMITTED = '[REDACTED]';
const FIELDS = ['error', 'errors', 'message', 'detail', 'error_description', 'description', 'reason',
    'title', 'code', 'type', 'status', 'status_code'];

function own(value, key) {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    } catch { return undefined; }
}

function secretList(values) {
    if (!Array.isArray(values)) return false;
    if (values.length > 128) return null;
    const result = new Set();
    let characters = 0;
    for (let index = 0; index < values.length; index++) {
        const value = own(values, index);
        if (typeof value !== 'string' || !value) continue;
        characters += value.length;
        if (characters > MAX_BYTES) return null;
        result.add(value);
        result.add(JSON.stringify(value).slice(1, -1));
        try { result.add(encodeURIComponent(value)); } catch { /* Lone surrogates have no URI encoding. */ }
    }
    const patterns = [...result].sort((a, b) => b.length - a.length)
        .map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return patterns.length ? new RegExp(patterns.join('|'), 'g') : false;
}

function redactSecrets(text, secrets) {
    // One literal pass avoids recursively expanding replacement markers containing another secret.
    return secrets ? text.replace(secrets, '') : text;
}

function decodeEntities(text) {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    for (let pass = 0; pass < 3; pass++) {
        text = text.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
            const name = entity.toLowerCase();
            if (named[name]) return named[name];
            const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : Number(name.slice(1));
            return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
        });
    }
    return text;
}

function redactText(text, secrets) {
    text = redactSecrets(text, secrets);
    text = text.replace(/[^\s<>"']+/g, value => {
        if (/^(?:[a-z][a-z\d+.-]*:)?\/\//i.test(value)) {
            try {
                const url = new URL(value, 'https://redaction.invalid');
                return `${value.startsWith('//') ? '' : url.protocol}//${url.host}${url.pathname}`;
            } catch { return '[URL omitted]'; }
        }
        const query = value.search(/[?#]/);
        return query < 0 ? value : value.slice(0, query);
    });
    text = text.replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi, OMITTED)
        .replace(/\b(?:sk-|sk_|gsk_|ghp_|github_pat_)[a-z\d_-]+/gi, OMITTED)
        .replace(/\beyJ[a-z\d_-]*\.[a-z\d_-]+\.[a-z\d_-]+/gi, OMITTED);
    // Once an unstructured request/header dump starts, its continuation is not safe error detail.
    text = text.replace(/(?:^|[\s,;{])['"]?(?:request(?:[ _-]?(?:body|payload|data))?|messages|prompts?|content|headers?|cookies?|set-cookie|body|payload|authorization|proxy-authorization|api[ _-]?keys?|x-api-key|passwords?|passwd|secrets?|(?:access[ _-]?|refresh[ _-]?|id[ _-]?)tokens?)['"]?\s*[:=][\s\S]*/gi,
        ` ${OMITTED}`);
    text = text.replace(/^\s*(?:x-[\w-]+|www-authenticate|proxy-authenticate)\s*:[\s\S]*/gim, OMITTED);
    return redactSecrets(text, secrets).replace(/[<>\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
        .replace(/&(?:#\w*|lt|gt);?/gi, '').trim();
}

// Fixed fields and a shared node/character budget avoid toJSON, getters and arbitrary object walks.
function extract(value, state, depth = 0) {
    if (--state.nodes < 0 || depth > 6) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'string') {
        state.characters -= value.length;
        if (value.length > MAX_BYTES || state.characters < 0) return 'Upstream error detail exceeds safety limit.';
        const raw = value.trim();
        if (/^[{[]/.test(raw)) {
            try { return extract(JSON.parse(raw), state, depth + 1); }
            catch { return 'Upstream returned incomplete or invalid structured error detail (body omitted).'; }
        }
        let text = decodeEntities(redactSecrets(value, state.secrets));
        if (/<\s*(?:!doctype|\/?[a-z][\w:-]*(?:\s|\/?>))/i.test(text)) {
            const title = /<title\b[^>]*>([^<]{0,1024})<\/title\s*>/i.exec(text);
            text = title ? title[1] : 'Upstream returned an HTML error page (body omitted).';
        }
        const trimmed = text.trim();
        if (/^[{[]/.test(trimmed) && !trimmed.startsWith(OMITTED)) {
            try { return extract(JSON.parse(trimmed), state, depth + 1); }
            catch { return 'Upstream returned incomplete or invalid structured error detail (body omitted).'; }
        }
        // Embedded JSON is another common request-echo format. Keep only its error fields.
        text = redactSecrets(text, state.secrets);
        const start = text.search(/\{|\[(?!REDACTED\])/);
        if (start >= 0 && !text.startsWith(OMITTED, start)) {
            const prefix = text.slice(0, start);
            try { text = `${prefix} ${extract(JSON.parse(text.slice(start)), state, depth + 1)}`; }
            catch { text = `${prefix} [Structured data omitted]`; }
        }
        return redactText(text, state.secrets);
    }
    if (!value || typeof value !== 'object' || state.seen.has(value)) return '';
    state.seen.add(value);
    if (Array.isArray(value)) {
        const items = [];
        for (let index = 0; index < Math.min(value.length, 8); index++) {
            const item = extract(own(value, index), state, depth + 1);
            if (item) items.push(item);
        }
        return items.join('; ');
    }
    const items = [];
    for (const field of FIELDS) {
        const item = extract(own(value, field), state, depth + 1);
        if (item) items.push(`${field}: ${item}`);
    }
    return items.join('; ');
}

/** Plain text only; callers must render with textContent, never innerHTML. maxLength is capped at 4000. */
export function sanitizeModelErrorDetail(value, { secrets = [], maxLength = MAX_DETAIL } = {}) {
    const limit = typeof maxLength === 'number' && Number.isFinite(maxLength)
        ? Math.max(0, Math.min(MAX_DETAIL, Math.floor(maxLength))) : MAX_DETAIL;
    if (!limit) return '';
    const safeSecrets = secretList(secrets);
    if (safeSecrets === null) return 'Upstream error detail omitted: invalid secret list.'.slice(0, limit);
    const state = { nodes: 128, characters: MAX_BYTES * 4, seen: new WeakSet(), secrets: safeSecrets };
    let result;
    try { result = extract(value, state); }
    catch { result = ''; }
    result = redactText(result || 'Upstream error (no safe detail available).', safeSecrets);
    return result.length > limit ? `${result.slice(0, Math.max(0, limit - 3))}${'.'.repeat(Math.min(3, limit))}` : result;
}

/** Consume at most 64 KiB of a response stream; no text()/json() fallback. Default deadline: 2 seconds. */
export async function readModelErrorDetail(response, options = {}) {
    const timeoutMs = typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.min(5000, Math.floor(options.timeoutMs))) : 2000;
    let reader;
    let timer;
    let completed = false;
    let note = 'Upstream response body is unavailable.';
    let text = '';
    let status = '';
    try {
        if (Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599) {
            status = `HTTP ${response.status}`;
        }
        reader = response?.body?.getReader?.();
        if (reader) {
            const deadline = new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
            });
            const decoder = new TextDecoder();
            let bytes = 0;
            let reads = 0;
            note = 'Upstream response body was incomplete (body omitted).';
            while (++reads <= 1024) {
                const part = await Promise.race([reader.read(), deadline]);
                if (part?.done === true) {
                    text += decoder.decode();
                    completed = true;
                    break;
                }
                if (!(part?.value instanceof Uint8Array)) break;
                bytes += part.value.byteLength;
                if (bytes > MAX_BYTES) {
                    note = 'Upstream response exceeded 64 KiB (body omitted).';
                    break;
                }
                text += decoder.decode(part.value, { stream: true });
            }
        }
    } catch {
        note = 'Upstream response could not be read within the deadline (body omitted).';
    } finally {
        clearTimeout(timer);
        if (reader && !completed) {
            // A broken stream's cancel promise must not extend the read deadline.
            try { Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* Best effort. */ }
        }
        try { reader?.releaseLock(); } catch { /* A timed-out read can still be pending. */ }
    }
    return sanitizeModelErrorDetail({ message: status, detail: completed ? text : note }, options);
}
