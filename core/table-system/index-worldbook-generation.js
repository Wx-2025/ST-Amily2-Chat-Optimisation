import { currentMemoryGeneration, prepareMemoryContribution, invalidateMemoryGeneration } from '../progressive-memory/generation-exchange.js';

const fail = code => { throw Object.assign(new Error(code), { code }); };

function textSlots(payload) {
    if (typeof payload?.prompt === 'string') return [{ read: () => payload.prompt, write: value => { payload.prompt = value; } }];
    if (!Array.isArray(payload?.chat)) fail('INDEX_WORLDBOOK_PROMPT_UNAVAILABLE');
    const slots = [];
    for (const message of payload.chat) {
        if (typeof message?.content === 'string') slots.push({ read: () => message.content, write: value => { message.content = value; } });
        else if (Array.isArray(message?.content)) {
            for (const part of message.content) if (part?.type === 'text' && typeof part.text === 'string') {
                slots.push({ read: () => part.text, write: value => { part.text = value; } });
            }
        }
    }
    return slots;
}

/** Candidates remain unclaimed until the host's final, mutable prompt event.
 * Markers are owned by this in-memory generation, never inferred from user text. */
export function createIndexWorldbookGeneration() {
    let pending = null;
    const installations = new Set();
    function clearInstalled() {
        for (const installation of installations) if (!installation.revoke()) fail('INDEX_WORLDBOOK_CLEAR_FAILED');
        installations.clear();
    }
    function stage({ scope, entries, provenance, isCurrent }) {
        clearInstalled();
        if (entries.length !== provenance.length || typeof isCurrent !== 'function') fail('INDEX_WORLDBOOK_GENERATION_INVALID');
        const handle = currentMemoryGeneration(scope);
        const nonce = globalThis.crypto.randomUUID();
        const records = entries.map((entry, index) => {
            const start = `<amily-index-${nonce}-${index}>`;
            const end = `</amily-index-${nonce}-${index}>`;
            return { start, end, block: `${start}\n${entry.content}\n${end}`, content: entry.content,
                coverage: [provenance[index].source] };
        });
        pending = { scope, handle, records, isCurrent, finalized: false };
        return entries.map((entry, index) => ({ ...entry, content: records[index].block }));
    }
    async function finalize(payload) {
        const batch = pending;
        if (!batch || batch.finalized) return;
        const slots = textSlots(payload);
        const original = slots.map(slot => slot.read());
        const active = [];
        let corrupt = false;
        for (const record of batch.records) {
            let occurrences = 0;
            original.forEach((text, slot) => {
                const starts = text.split(record.start).length - 1;
                const ends = text.split(record.end).length - 1;
                const blocks = text.split(record.block).length - 1;
                if (starts !== blocks || ends !== blocks) corrupt = true;
                if (blocks) { occurrences += blocks; active.push({ ...record, slot }); }
            });
            if (occurrences > 1) corrupt = true;
        }
        const strip = () => {
            for (const slot of slots) {
                let text = slot.read();
                for (const record of batch.records) text = text.split(record.block).join('');
                slot.write(text);
            }
        };
        const current = () => {
            try { return pending === batch && batch.isCurrent() !== false
                && currentMemoryGeneration(batch.scope) === batch.handle
                && (!installed || installed.isCurrent()); } catch { return false; }
        };
        let receipt;
        let installed;
        try {
            if (corrupt) fail('INDEX_WORLDBOOK_PROMPT_CHANGED');
            // Unrelated raw/quiet events do not consume this main generation.
            if (!active.length) return;
            if (payload.dryRun) { strip(); return; }
            if (!batch.handle || !current()) fail('INDEX_WORLDBOOK_GENERATION_STALE');
            // The complete contribution includes the real separators left in the
            // final prompt. Do not count trigger candidates or table cell length.
            receipt = await prepareMemoryContribution(batch.handle, { consumer: 'index-worldbook', candidates: active,
                render: selected => selected.map(record => record.content).join('\n'), isCurrent: current,
                revoke: () => installed?.revoke() ?? true });
            if (!current() || slots.some((slot, index) => slot.read() !== original[index])) fail('INDEX_WORLDBOOK_PROMPT_CHANGED');
            const selected = new Set(receipt.selected);
            const applied = original.map((text, index) => {
                for (const record of active.filter(item => item.slot === index)) {
                    text = text.replace(record.block, selected.has(record) ? record.content : '');
                }
                return text;
            });
            const cleaned = original.map(text => batch.records.reduce((value, record) => value.split(record.block).join(''), text));
            installed = { isCurrent: () => slots.every((slot, index) => slot.read() === applied[index]), revoke() {
                // Exact destination CAS: never remove matching prose belonging to
                // another consumer after the host has changed the destination.
                if (slots.some((slot, index) => slot.read() !== applied[index])) return false;
                slots.forEach((slot, index) => slot.write(cleaned[index]));
                installations.delete(installed);
                return true;
            } };
            slots.forEach((slot, index) => slot.write(applied[index]));
            receipt.commit();
            installations.add(installed);
            batch.finalized = true;
            return { entries: receipt.selected.length, excluded: receipt.excluded.length, tokens: receipt.tokens };
        } catch (error) {
            if (installed) installed.revoke();
            strip();
            if (batch.handle) await invalidateMemoryGeneration(batch.handle);
            throw error;
        } finally { receipt?.release(); }
    }
    return { stage, finalize, invalidate() { pending = null; clearInstalled(); } };
}
