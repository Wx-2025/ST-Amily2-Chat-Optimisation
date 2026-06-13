/**
 * core/progressive-memory/sampler.js
 *
 * 渐进式记忆采样（梯度记忆）：行序假定为 旧 → 新（追加式表格，如总结表）。
 *
 *   [───── 远区（历史前 50%）─────][───── 中区（历史后 50%）─────][最新 recentCount 行]
 *           等距取 farCount 行            等距取 midCount 行              全量保留
 *
 * 设计约束（与用户确认）：
 *   - 不随机、不首尾加权——等距（中心对齐）抽样，时间分布均匀、结果可预期，
 *     避免内容扎堆在某段时期或事件结局被采样规律性忽略。
 *   - 参数为纯 JSON（recentCount / midCount / farCount），后续可直接作为
 *     memory-blocks 工作链的 progressive_sample 节点参数平移。
 *
 * 本模块只做"选哪些行"的纯计算，不涉及渲染与世界书写入。
 */

/**
 * 中心对齐等距抽样：从长度 length 的区间内取 count 个索引。
 * 取样点 = floor((i + 0.5) * length / count)，使样本落在各等分段的中点，
 * 避免"恒取区间开头/结尾"造成的边界偏置。
 *
 * @param {number} length 区间长度
 * @param {number} count  期望取样数
 * @returns {number[]} 升序、去重后的区间内偏移索引（0-based）
 */
export function evenIndices(length, count) {
    if (length <= 0 || count <= 0) return [];
    if (count >= length) return Array.from({ length }, (_, i) => i);
    const out = new Set();
    for (let i = 0; i < count; i++) {
        out.add(Math.floor((i + 0.5) * length / count));
    }
    return [...out].sort((a, b) => a - b);
}

/**
 * 渐进式采样主入口。
 *
 * @param {number} totalCount 候选行总数（已过滤掉删除中/无主键的行之后）
 * @param {{ recentCount?: number, midCount?: number, farCount?: number }} [params]
 * @returns {number[]} 升序的入选行索引（相对候选序列，0 = 最旧）
 */
export function sampleProgressive(totalCount, params = {}) {
    const recentCount = Math.max(0, params.recentCount ?? 5);
    const midCount = Math.max(0, params.midCount ?? 5);
    const farCount = Math.max(0, params.farCount ?? 3);

    if (totalCount <= 0) return [];

    const picked = new Set();

    // 最新 recentCount 行全量
    const recent = Math.min(recentCount, totalCount);
    const recentStart = totalCount - recent;
    for (let i = recentStart; i < totalCount; i++) picked.add(i);

    // 历史区 [0, recentStart)，对半拆：前半=远区，后半=中区（更靠近现在）
    const histLen = recentStart;
    if (histLen > 0) {
        const farLen = Math.floor(histLen / 2);
        const midLen = histLen - farLen;

        for (const offset of evenIndices(midLen, midCount)) picked.add(farLen + offset);
        for (const offset of evenIndices(farLen, farCount)) picked.add(offset);
    }

    return [...picked].sort((a, b) => a - b);
}
