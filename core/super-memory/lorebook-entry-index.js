export function indexLorebookEntriesByComment(entries) {
    const byComment = new Map();
    for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || typeof entry.comment !== 'string' || byComment.has(entry.comment)) continue;
        byComment.set(entry.comment, entry);
    }
    return byComment;
}
