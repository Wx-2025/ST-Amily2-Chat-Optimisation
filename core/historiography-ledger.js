/**
 * Pure helpers for the historiographer's rolling ledger.
 *
 * The active ledger keeps one bounded rolling "宏史卷" plus the newest,
 * not-yet-refined "微言录" blocks. Every destructive-looking replacement is
 * performed by historiographer.js only after it has created a disabled,
 * byte-for-byte source archive in the same lorebook.
 */

export const PROGRESS_SEAL_REGEX =
    /本条勿动【前(\d+)楼总结已完成】否则后续总结无法进行。$/;
export const CHAPTER_SEAL_REGEX = /【前(\d+)楼篇章编撰已完成】/;
export const MICRO_SUMMARY_HEADING_REGEX =
    /【(\d+)楼至(\d+)楼详细总结记录】/g;
export const RESERVED_LEDGER_STRUCTURE_REGEX =
    /本条勿动【前\d+楼总结已完成】否则后续总结无法进行。?|【前\d+楼篇章编撰已完成】|【\d+楼至\d+楼详细总结记录】/u;
export const LEGACY_VECTORIZED_PLACEHOLDER_REGEX =
    /AI你好，以上内容为rag向量化后注入的相关剧情|前\d+楼聊天记录总结已由翰林院向量化注入|【以下内容为\d+楼以后的总结内容】/iu;

const MIN_INPUT_TOKEN_BUDGET = 4000;
const MAX_INPUT_TOKEN_BUDGET = 128000;
const MIN_ACTIVE_TOKEN_BUDGET = 1000;
const MAX_ACTIVE_TOKEN_BUDGET = 32000;
export const REFINEMENT_INPUT_RESERVE_TOKENS = 4000;

function clampInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    const normalized = Number.isFinite(parsed) ? parsed : fallback;
    return Math.max(min, Math.min(max, normalized));
}

export function estimateHistoriographyTokens(text) {
    const value = String(text ?? '');
    if (!value) return 0;
    let cjk = 0;
    const nonCjk = value.replace(/[\u3000-\u9fff\u3040-\u30ff\uac00-\ud7af]/gu, () => {
        cjk += 1;
        return '';
    });
    // Historiography can contain code, punctuation, emoji, identifiers and
    // other material whose token density is much higher than ordinary English.
    // Two UTF-16 code units per token is deliberately conservative compared
    // with the old /4 approximation. Exact provider tokenizers remain the only
    // way to turn this estimate into a model-specific context guarantee.
    return cjk + Math.ceil(nonCjk.length / 2);
}

export function estimateHistoriographyMessagesTokens(messages = []) {
    if (!Array.isArray(messages)) return 0;
    return messages.reduce((total, message) => {
        const role = String(message?.role ?? '');
        const content = String(message?.content ?? '');
        // Reserve a small per-message envelope for role/name/framing tokens.
        return total + estimateHistoriographyTokens(role)
            + estimateHistoriographyTokens(content)
            + 8;
    }, 2);
}

export function normalizeRefinementLimits(settings = {}) {
    const reminderBlocks = clampInteger(
        settings.historiographyRefineReminderBlocks,
        40,
        5,
        500,
    );
    const activeMaxTokens = clampInteger(
        settings.historiographyRollingSummaryMaxTokens,
        12000,
        MIN_ACTIVE_TOKEN_BUDGET,
        MAX_ACTIVE_TOKEN_BUDGET,
    );
    let inputMaxTokens = clampInteger(
        settings.historiographyRefineInputMaxTokens,
        48000,
        MIN_INPUT_TOKEN_BUDGET,
        MAX_INPUT_TOKEN_BUDGET,
    );
    // Never permit a persisted combination that leaves no room for prompts
    // and the selected micro-summary evidence around the rolling output.
    inputMaxTokens = Math.max(
        inputMaxTokens,
        activeMaxTokens + REFINEMENT_INPUT_RESERVE_TOKENS,
    );
    inputMaxTokens = Math.min(MAX_INPUT_TOKEN_BUDGET, inputMaxTokens);
    return { reminderBlocks, inputMaxTokens, activeMaxTokens };
}

export function parseLedgerForRefinement(content) {
    const source = String(content ?? '');
    const progressSealMatch = source.match(PROGRESS_SEAL_REGEX);
    if (!progressSealMatch) {
        return {
            valid: false,
            reason: 'missing-progress-seal',
            source,
            progressSeal: '',
            totalFloors: 0,
            compiledFloor: 0,
            existingRollingContent: '',
            pendingMicroContent: '',
            pendingBlockCount: 0,
            pendingBlocks: [],
            requiresHistoricalRecovery: false,
        };
    }

    const progressSeal = progressSealMatch[0];
    const totalFloors = Number.parseInt(progressSealMatch[1], 10) || 0;
    const withoutProgress = source.replace(PROGRESS_SEAL_REGEX, '').trim();
    const chapterSealMatch = withoutProgress.match(CHAPTER_SEAL_REGEX);

    let compiledFloor = 0;
    let existingRollingContent = '';
    let pendingMicroContent = withoutProgress;
    if (chapterSealMatch) {
        compiledFloor = Number.parseInt(chapterSealMatch[1], 10) || 0;
        const sealIndex = chapterSealMatch.index ?? -1;
        existingRollingContent = sealIndex >= 0
            ? withoutProgress.slice(0, sealIndex).trim()
            : '';
        pendingMicroContent = sealIndex >= 0
            ? withoutProgress.slice(sealIndex + chapterSealMatch[0].length).trim()
            : '';
    }

    const pendingBlocks = Array.from(
        pendingMicroContent.matchAll(MICRO_SUMMARY_HEADING_REGEX),
        match => ({
            startFloor: Number.parseInt(match[1], 10) || 0,
            endFloor: Number.parseInt(match[2], 10) || 0,
            headingIndex: match.index ?? 0,
            heading: match[0],
        }),
    );
    const pendingBlockCount = pendingBlocks.length;
    // matchAll on a global regex leaves lastIndex observable in some older
    // engines. Reset it so repeated calls remain deterministic.
    MICRO_SUMMARY_HEADING_REGEX.lastIndex = 0;
    // Some historical vectorized ledgers have no chapter seal at all, so the
    // placeholder can otherwise be misclassified as pending micro content.
    // Search the whole persisted body and fail closed whenever the original
    // early-floor text has already been replaced by the old Hanlinyuan notice.
    const requiresHistoricalRecovery =
        LEGACY_VECTORIZED_PLACEHOLDER_REGEX.test(withoutProgress);

    return {
        valid: !requiresHistoricalRecovery,
        reason: requiresHistoricalRecovery ? 'legacy-vector-placeholder' : '',
        source,
        progressSeal,
        totalFloors,
        compiledFloor,
        existingRollingContent,
        pendingMicroContent,
        pendingBlockCount,
        pendingBlocks,
        requiresHistoricalRecovery,
    };
}

function findPendingBoundaryBeforeHeading(source, headingIndex) {
    if (!(headingIndex > 0)) return 0;
    const prefix = source.slice(0, headingIndex);
    const match = prefix.match(/(?:\r?\n){1,3}---(?:\r?\n){1,3}\s*$/u);
    return match?.index ?? headingIndex;
}

export function partitionPendingMicroContent(parsedLedger, selectedBlockCount) {
    const parsed = parsedLedger || {};
    const source = String(parsed.pendingMicroContent ?? '');
    const blocks = Array.isArray(parsed.pendingBlocks)
        ? parsed.pendingBlocks
        : [];
    const count = Math.max(
        0,
        Math.min(blocks.length, Number.parseInt(selectedBlockCount, 10) || 0),
    );
    if (count === 0) {
        return {
            selectedBlockCount: 0,
            selectedContent: '',
            remainingContent: source,
            selectedEndFloor: Number.parseInt(parsed.compiledFloor, 10) || 0,
        };
    }

    const nextBlock = blocks[count];
    const boundary = nextBlock
        ? findPendingBoundaryBeforeHeading(source, nextBlock.headingIndex)
        : source.length;
    return {
        selectedBlockCount: count,
        selectedContent: source.slice(0, boundary),
        remainingContent: source.slice(boundary),
        selectedEndFloor:
            Number.parseInt(blocks[count - 1]?.endFloor, 10)
            || Number.parseInt(parsed.compiledFloor, 10)
            || 0,
    };
}

export function buildRollingRefinementInput(
    parsedLedger,
    selectedBlockCount = parsedLedger?.pendingBlockCount,
) {
    const parsed = parsedLedger || {};
    if (parsed.requiresHistoricalRecovery) return '';
    const partition = partitionPendingMicroContent(parsed, selectedBlockCount);
    const sections = [];
    if (String(parsed.existingRollingContent ?? '').trim()) {
        sections.push(
            `<既有宏史卷 覆盖楼层="1-${parsed.compiledFloor || 0}">\n`
            + `${String(parsed.existingRollingContent).trim()}\n`
            + '</既有宏史卷>',
        );
    }
    if (String(partition.selectedContent ?? '').trim()) {
        const pendingStart = Math.max(1, (parsed.compiledFloor || 0) + 1);
        sections.push(
            `<待合并微言录 覆盖楼层="${pendingStart}-${partition.selectedEndFloor || 0}">\n`
            + `${String(partition.selectedContent).trim()}\n`
            + '</待合并微言录>',
        );
    }
    return sections.join('\n\n');
}

export function buildRollingLedgerContent(
    summary,
    parsedLedger,
    selectedBlockCount = parsedLedger?.pendingBlockCount,
) {
    const parsed = parsedLedger || {};
    const totalFloors = Math.max(0, Number.parseInt(parsed.totalFloors, 10) || 0);
    const partition = partitionPendingMicroContent(parsed, selectedBlockCount);
    const compiledFloor = Math.max(
        0,
        Number.parseInt(partition.selectedEndFloor, 10)
        || Number.parseInt(parsed.compiledFloor, 10)
        || 0,
    );
    const cleanSummary = String(summary ?? '').trim();
    const progressSeal = String(parsed.progressSeal ?? '').trim();
    if (!cleanSummary || !progressSeal || totalFloors <= 0 || compiledFloor <= 0) {
        return '';
    }

    const rolling = [
        `以下内容是【1楼-${compiledFloor}楼】已发生剧情的滚动宏史卷。`,
        '',
        '---',
        '',
        cleanSummary,
        '',
        `【前${compiledFloor}楼篇章编撰已完成】`,
    ].join('\n');
    const remaining = String(partition.remainingContent ?? '');
    const withRemaining = remaining
        ? `${rolling}${remaining.startsWith('\n') ? '' : '\n\n'}${remaining}`
        : rolling;
    return `${withRemaining}\n\n${progressSeal}`;
}

export function appendMicroSummaryBlock(
    oldContent,
    summary,
    startFloor,
    endFloor,
    maxTokens,
) {
    const start = Math.max(1, Number.parseInt(startFloor, 10) || 1);
    const end = Math.max(start, Number.parseInt(endFloor, 10) || start);
    const budget = clampInteger(
        maxTokens,
        48000,
        MIN_INPUT_TOKEN_BUDGET,
        MAX_INPUT_TOKEN_BUDGET,
    );
    const source = String(oldContent ?? '');
    const newSeal =
        `\n\n本条勿动【前${end}楼总结已完成】否则后续总结无法进行。`;
    const newChapter =
        `\n\n---\n\n【${start}楼至${end}楼详细总结记录】\n`
        + String(summary ?? '').trim();
    const content = source
        ? `${source.replace(PROGRESS_SEAL_REGEX, '').trim()}${newChapter}${newSeal}`
        : `以下是依照顺序已发生剧情${newChapter}${newSeal}`;
    const estimatedTokens = estimateHistoriographyTokens(content);
    return {
        fits: estimatedTokens <= budget,
        content,
        estimatedTokens,
        maxTokens: budget,
    };
}

export function rollingSummaryFitsBudget(summary, maxTokens) {
    const budget = clampInteger(
        maxTokens,
        12000,
        MIN_ACTIVE_TOKEN_BUDGET,
        MAX_ACTIVE_TOKEN_BUDGET,
    );
    return {
        fits: estimateHistoriographyTokens(summary) <= budget,
        estimatedTokens: estimateHistoriographyTokens(summary),
        maxTokens: budget,
    };
}

export function rollingLedgerFitsBudget(
    summary,
    parsedLedger,
    maxTokens,
    selectedBlockCount = parsedLedger?.pendingBlockCount,
) {
    const partition = partitionPendingMicroContent(
        parsedLedger,
        selectedBlockCount,
    );
    const compiledFloor = Math.max(
        0,
        Number.parseInt(partition.selectedEndFloor, 10)
        || Number.parseInt(parsedLedger?.compiledFloor, 10)
        || 0,
    );
    const rollingSection = compiledFloor > 0
        ? [
            `以下内容是【1楼-${compiledFloor}楼】已发生剧情的滚动宏史卷。`,
            '',
            '---',
            '',
            String(summary ?? '').trim(),
            '',
            `【前${compiledFloor}楼篇章编撰已完成】`,
        ].join('\n')
        : '';
    const content = buildRollingLedgerContent(
        summary,
        parsedLedger,
        selectedBlockCount,
    );
    const budget = clampInteger(
        maxTokens,
        12000,
        MIN_ACTIVE_TOKEN_BUDGET,
        MAX_ACTIVE_TOKEN_BUDGET,
    );
    // The activeMaxTokens setting bounds the rolling macro-history produced by
    // the model, not the untouched micro-summary tail. During staged
    // compaction that tail may legitimately remain much larger and is governed
    // by the separate input/ledger ceiling on the next pass.
    const estimatedTokens = estimateHistoriographyTokens(rollingSection);
    return {
        fits: Boolean(content) && Boolean(rollingSection) && estimatedTokens <= budget,
        content,
        estimatedTokens,
        maxTokens: budget,
    };
}

export function containsReservedLedgerStructure(text) {
    return RESERVED_LEDGER_STRUCTURE_REGEX.test(String(text ?? ''));
}
