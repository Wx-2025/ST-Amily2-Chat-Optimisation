/**
 * core/progressive-memory/ledger-reader.js — 金账文本解析（真压缩·产物编排）
 *
 * 渐进记忆远带不自建压缩器，而是读取史官已产出的宏史卷（真压缩设计稿结论）。
 * 本模块把金账条目（【敕史局】对话流水总帐）的原始文本解析为结构化产物：
 *
 *   宏史卷区（首个微言录章节之前的精炼文本）
 *   微言录章节[]（【X楼至Y楼详细总结记录】块）
 *   进度楼层（本条勿动【前N楼总结已完成】封印）
 *   宏史卷覆盖楼层（【前N楼篇章编撰已完成】章节封印）
 *
 * 纯函数、零依赖，可离线测试。对三种金账形态均兼容：
 *   a) 未重铸：header + 章节 + 进度封印
 *   b) 标准重铸：旧宏史卷 + ===【截止至第N楼的宏史卷】=== + 新宏史卷 + 封印
 *   c) 向量化重铸：占位说明（旧卷已入翰林院）+ --- + 新宏史卷 + 封印
 */

const PROGRESS_SEAL_RE = /本条勿动【前(\d+)楼总结已完成】否则后续总结无法进行。?/g;
const CHAPTER_SEAL_RE = /【前(\d+)楼篇章编撰已完成】/g;
const CHAPTER_HEAD_RE = /【(\d+)楼至(\d+)楼详细总结记录】/g;
// 未重铸形态的引导行 与 向量化重铸后的占位说明（旧卷正文已不在本地，剔除避免注入废话）
const NOISE_LINES = [
    /^以下是依照顺序已发生剧情\s*$/m,
    /^AI你好，以上内容为rag向量化后注入的相关剧情，以下内容是已发生的剧情回顾。\s*$/m,
    /^（前\d+楼聊天记录总结已由翰林院向量化注入。）\s*$/m,
    /^【以下内容为\d+楼以后的总结内容】\s*$/m,
];

/**
 * 解析金账条目文本。
 * @param {string} text 金账条目 content 原文
 * @returns {{
 *   grandScroll: string,          宏史卷区文本（清洗后；可能为空串=尚未重铸过）
 *   grandScrollFloor: number|null, 宏史卷覆盖到的楼层（最大的篇章编撰封印值）
 *   chapters: Array<{start:number, end:number, text:string}>, 微言录章节（旧→新）
 *   progressFloor: number|null,    总结进度（进度封印值）
 * }}
 */
export function parseLedgerContent(text) {
    const empty = { grandScroll: "", grandScrollFloor: null, chapters: [], progressFloor: null };
    if (!text || typeof text !== "string") return empty;

    // 进度封印
    let progressFloor = null;
    for (const m of text.matchAll(PROGRESS_SEAL_RE)) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && (progressFloor === null || n > progressFloor)) progressFloor = n;
    }

    // 宏史卷覆盖楼层（取最大）
    let grandScrollFloor = null;
    for (const m of text.matchAll(CHAPTER_SEAL_RE)) {
        const n = parseInt(m[1], 10);
        if (Number.isFinite(n) && (grandScrollFloor === null || n > grandScrollFloor)) grandScrollFloor = n;
    }

    // 微言录章节切分：按章节头定位，每章内容延伸到下一章头或文末
    const heads = [...text.matchAll(CHAPTER_HEAD_RE)];
    const chapters = [];
    for (let i = 0; i < heads.length; i++) {
        const head = heads[i];
        const bodyStart = head.index + head[0].length;
        const bodyEnd = i + 1 < heads.length ? heads[i + 1].index : text.length;
        const body = stripSeals(text.slice(bodyStart, bodyEnd));
        chapters.push({
            start: parseInt(head[1], 10),
            end: parseInt(head[2], 10),
            text: body.trim(),
        });
    }

    // 宏史卷区 = 首个章节头之前的全部文本（无章节则为全文），去封印与噪声行
    const scrollRawEnd = heads.length > 0 ? heads[0].index : text.length;
    let grandScroll = stripSeals(text.slice(0, scrollRawEnd));
    for (const re of NOISE_LINES) grandScroll = grandScroll.replace(re, "");
    // 去掉章节分隔残留（`---`）与多余空行
    grandScroll = grandScroll
        .split("\n")
        .filter(line => line.trim() !== "---")
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

    return { grandScroll, grandScrollFloor, chapters, progressFloor };
}

function stripSeals(s) {
    return s.replace(PROGRESS_SEAL_RE, "").replace(CHAPTER_SEAL_RE, "");
}

/**
 * 保尾截断：宏史卷内部越靠后越接近现在，信息价值更高——超预算时从头部丢弃。
 * 按行为单位截断，避免把句子拦腰斩断。
 *
 * @param {string} text
 * @param {number} maxTokens 0 或负数 = 不限制
 * @param {(s: string) => number} estimator token 估算函数
 * @returns {string}
 */
export function truncateKeepTail(text, maxTokens, estimator) {
    if (!text) return "";
    const budget = parseInt(maxTokens, 10);
    if (!Number.isFinite(budget) || budget <= 0) return text;
    if (estimator(text) <= budget) return text;

    const lines = text.split("\n");
    const kept = [];
    let used = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
        const cost = estimator(lines[i]) + 1; // +1 计换行
        if (kept.length > 0 && used + cost > budget) break; // 至少保留最后一行
        used += cost;
        kept.push(lines[i]);
    }
    const result = kept.reverse().join("\n").trim();
    return result ? `（更早内容已省略）\n${result}` : text;
}
