/**
 * Runtime guard for table-filler preset chains.
 *
 * Older/custom preset data may contain an empty order or omit a newly required
 * conditional block.  Persisted presets are left untouched; the current call
 * receives a safe, completed copy so it can never be sent without the target
 * content, table rules, or current table snapshot.
 */

export const BATCH_REQUIRED_FILLER_BLOCKS = Object.freeze([
    'coreContent',
    'ruleTemplate',
    'flowTemplate',
]);

export const SECONDARY_REQUIRED_FILLER_BLOCKS = Object.freeze([
    'ruleTemplate',
    'flowTemplate',
    'coreContent',
]);

export const REQUIRED_FILLER_BLOCKS = SECONDARY_REQUIRED_FILLER_BLOCKS;

/**
 * @param {unknown} configuredOrder
 * @param {readonly string[]} requiredBlockIds
 * @returns {{ order: Array<{type: string, id?: string, index?: number}>, added: string[] }}
 */
export function completeFillerPromptOrder(
    configuredOrder,
    requiredBlockIds = REQUIRED_FILLER_BLOCKS,
) {
    const order = Array.isArray(configuredOrder)
        ? configuredOrder
            .filter(item => item && typeof item === 'object')
            .map(item => ({ ...item }))
        : [];
    const required = new Set(requiredBlockIds);
    const present = new Set();
    for (let index = 0; index < order.length;) {
        const item = order[index];
        if (item.type !== 'conditional' || !required.has(item.id)) {
            index += 1;
            continue;
        }
        if (present.has(item.id)) {
            order.splice(index, 1);
        } else {
            present.add(item.id);
            index += 1;
        }
    }
    const added = [];

    for (const id of requiredBlockIds) {
        if (present.has(id)) continue;
        const canonicalIndex = requiredBlockIds.indexOf(id);
        let insertionIndex = -1;

        for (let next = canonicalIndex + 1; next < requiredBlockIds.length; next++) {
            const nextIndex = order.findIndex(item => (
                item.type === 'conditional' && item.id === requiredBlockIds[next]
            ));
            if (nextIndex !== -1) {
                insertionIndex = nextIndex;
                break;
            }
        }
        if (insertionIndex === -1) {
            for (let previous = canonicalIndex - 1; previous >= 0; previous--) {
                const previousIndex = order.findIndex(item => (
                    item.type === 'conditional' && item.id === requiredBlockIds[previous]
                ));
                if (previousIndex !== -1) {
                    insertionIndex = previousIndex + 1;
                    break;
                }
            }
        }
        if (insertionIndex === -1) {
            const trailingPromptIndex = order.findIndex(item => (
                item.type === 'prompt'
                && Number.isSafeInteger(item.index)
                && item.index >= 7
            ));
            insertionIndex = trailingPromptIndex === -1 ? order.length : trailingPromptIndex;
        }

        order.splice(insertionIndex, 0, { type: 'conditional', id });
        present.add(id);
        added.push(id);
    }

    return { order, added };
}

export function buildFillerFlowPrompt(flowTemplate, tableSnapshot) {
    const template = String(flowTemplate ?? '');
    const snapshot = String(tableSnapshot ?? '');
    const placeholder = '{{{Amily2TableData}}}';
    if (template.includes(placeholder)) {
        return template.split(placeholder).join(snapshot);
    }
    return `${template.trim()}\n\n<当前表格数据>\n${snapshot}\n</当前表格数据>`.trim();
}
