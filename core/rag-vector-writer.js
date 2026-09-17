import { sha256TextHex } from './utils/sha256.js';

// The host stores hash as metadata; /insert does NOT upsert by that hash.
// Serialize the read/check/write sequence, not just the embedding request.
const collectionQueues = new Map();

function assertNotAborted(signal) {
    if (signal?.aborted) {
        throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    }
}

export async function ragChunkHash(collectionId, text) {
    const digest = await sha256TextHex(JSON.stringify([
        'amily2-rag-chunk-v1', collectionId, text,
    ]));
    // /list coerces hashes to Number. Use an exactly representable 52-bit
    // digest, not a hex/base36 string which the host would turn into NaN.
    return Number.parseInt(digest.slice(0, 13), 16);
}

async function withCollectionLock(collectionId, signal, getLocks, operation) {
    const name = `amily2-rag-write:${collectionId}`;
    const previous = collectionQueues.get(name) ?? Promise.resolve();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    collectionQueues.set(name, pending);
    try {
        await previous;
        assertNotAborted(signal);
        const locks = getLocks();
        if (typeof locks?.request === 'function') {
            // Web Locks additionally coordinate tabs on this browser/origin.
            // The host has no cross-device atomic insert-if-absent API.
            return await locks.request(name, {
                mode: 'exclusive', ...(signal ? { signal } : {}),
            }, operation);
        }
        return await operation();
    } finally {
        release();
        if (collectionQueues.get(name) === pending) collectionQueues.delete(name);
    }
}

export function createRagVectorWriter({
    fetchImpl,
    getRequestHeaders,
    embedTexts,
    getLocks = () => globalThis.navigator?.locks,
} = {}) {
    if ([fetchImpl, getRequestHeaders, embedTexts, getLocks].some(fn => typeof fn !== 'function')) {
        throw new TypeError('RAG vector writer dependencies are incomplete.');
    }

    async function request(path, body, signal) {
        assertNotAborted(signal);
        const response = await fetchImpl(path, {
            method: 'POST', headers: getRequestHeaders(),
            body: JSON.stringify(body), signal,
        });
        assertNotAborted(signal);
        if (!response.ok) {
            throw new Error(`向量${path.endsWith('/list') ? '去重核对' : '写入'}失败（HTTP ${response.status}），请重试。`);
        }
        return response;
    }

    async function listHashes(collectionId, signal) {
        const response = await request('/api/vector/list', {
            collectionId, source: 'webllm', embeddings: {},
        }, signal);
        const result = await response.json();
        const raw = Array.isArray(result) ? result : result?.hashes;
        if (!Array.isArray(raw)) throw new Error('向量去重核对返回格式异常，本次未继续写入。');
        const hashes = new Set();
        for (const value of raw) {
            // Historical base36 hashes are exposed by the host as null. Do not
            // coerce them to zero or rewrite/delete those existing records.
            if (value === null) continue;
            if (typeof value !== 'number' && typeof value !== 'string') {
                throw new Error('向量去重核对返回了无效记录，本次未继续写入。');
            }
            if (typeof value === 'string' && !/^\d+$/.test(value)) continue;
            const hash = Number(value);
            if (Number.isSafeInteger(hash) && hash >= 0) hashes.add(hash);
        }
        return hashes;
    }

    return Object.freeze({
        async write(collectionId, chunks, { signal = null } = {}) {
            if (typeof collectionId !== 'string' || !collectionId.trim()) {
                throw new TypeError('向量写入缺少知识库 ID。');
            }
            if (!Array.isArray(chunks)) throw new TypeError('向量写入需要文本块数组。');
            const texts = chunks.map(chunk => {
                if (typeof chunk?.text !== 'string' || !chunk.text.trim()) {
                    throw new TypeError('向量写入不能包含空文本块。');
                }
                return chunk.text;
            });
            const empty = { success: true, count: 0, skipped: texts.length };
            assertNotAborted(signal);
            if (!texts.length) return empty;

            return withCollectionLock(collectionId, signal, getLocks, async () => {
                assertNotAborted(signal);
                const unique = new Map();
                for (const text of texts) {
                    const hash = await ragChunkHash(collectionId, text);
                    if (unique.has(hash) && unique.get(hash).text !== text) {
                        throw new Error('检测到向量记录指纹冲突，本次未继续写入。');
                    }
                    unique.set(hash, { hash, text });
                }
                const before = await listHashes(collectionId, signal);
                const missing = [...unique.values()].filter(item => !before.has(item.hash));
                if (!missing.length) return empty;

                // Deduplicate before calling the billable embedding provider.
                const vectors = await embedTexts(missing.map(item => item.text), signal);
                assertNotAborted(signal);
                if (!Array.isArray(vectors) || vectors.length !== missing.length) {
                    throw new Error('文本块和向量数量不匹配。');
                }
                const dimensions = vectors[0]?.length;
                if (!dimensions || vectors.some(vector =>
                    (!Array.isArray(vector) && !ArrayBuffer.isView(vector))
                    || vector.length !== dimensions
                    || Array.from(vector).some(value => typeof value !== 'number' || !Number.isFinite(value)))) {
                    throw new Error('向量数据格式异常，本次未继续写入。');
                }

                // A separate client may have written during the model call.
                // Recheck persistent state; never trust a page-local cache.
                const latest = await listHashes(collectionId, signal);
                const items = [];
                const embeddings = Object.create(null);
                missing.forEach((item, index) => {
                    if (latest.has(item.hash)) return;
                    items.push({ ...item, index });
                    embeddings[item.text] = Array.from(vectors[index]);
                });
                if (!items.length) return empty;
                await request('/api/vector/insert', {
                    collectionId, source: 'webllm', items, embeddings,
                }, signal);

                // A lost response is safe to retry: the next write lists the
                // committed hashes and skips them, even after a page reload.
                const after = await listHashes(collectionId, signal);
                if (items.some(item => !after.has(item.hash))) {
                    throw new Error('向量写入未通过回读确认，请重试；已存在的记录不会重复提交。');
                }
                return { success: true, count: items.length, skipped: texts.length - items.length };
            });
        },
    });
}
