
export function extractBlocksByTags(text, tagNames) {
    if (!text || !tagNames || !Array.isArray(tagNames) || tagNames.length === 0) {
        return [];
    }

    const allBlocks = [];
    tagNames.forEach(tagName => {
        const trimmedTag = tagName.trim();
        if (trimmedTag) {

            const regex = new RegExp(`<${trimmedTag}[^>]*>[\\s\\S]*?<\\/${trimmedTag}>`, 'g');
            const matches = text.match(regex);
            if (matches) {
                allBlocks.push(...matches);
            }
        }
    });

    return allBlocks;
}

export function applyExclusionRules(text, rules) {
    if (!text || !rules || !Array.isArray(rules) || rules.length === 0) {
        return text;
    }

    let processedText = text;

    rules.forEach(rule => {
        if (rule.start && rule.end) {
            // 为了安全地在正则表达式中使用，需要转义特殊字符
            const start = rule.start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const end = rule.end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            
            // 创建一个非全局的、懒惰匹配的正则表达式
            const regex = new RegExp(`${start}[\\s\\S]*?${end}`);
            
            // 循环替换，直到文本中再也找不到匹配项为止。
            // 这种方法可以避免全局标志 'g' 在某些复杂情况下可能出现的贪婪行为。
            while (regex.test(processedText)) {
                processedText = processedText.replace(regex, '');
            }
        }
    });

    return processedText;
}

export function previewRuleExtraction(text, profile = {}, { isUser = false } = {}) {
    const source = String(text ?? '');
    const result = {
        content: '',
        mode: 'disabled',
        matchedTags: [],
        unmatchedTags: [],
        excludedCharacters: 0,
    };
    if (isUser && profile.excludeUserMessages) {
        return { ...result, mode: 'skipped' };
    }

    let content = source;
    if (profile.tagExtractionEnabled) {
        const tags = String(profile.tags || '').split(',').map(tag => tag.trim()).filter(Boolean);
        const blocks = [];
        for (const tag of tags) {
            const matches = extractBlocksByTags(source, [tag]);
            if (matches.length) {
                result.matchedTags.push({ tag, count: matches.length });
                blocks.push(...matches);
            } else {
                result.unmatchedTags.push(tag);
            }
        }
        // Keep the runtime's tag order, full blocks and no-match fallback.
        result.mode = !tags.length ? 'no-tags' : blocks.length ? 'extracted' : 'fallback';
        if (blocks.length) content = blocks.join('\n\n');
    }

    const filtered = applyExclusionRules(content, profile.exclusionRules || []);
    result.excludedCharacters = content.length - filtered.length;
    result.content = filtered.trim();
    return result;
}
