/**
 * core/memory-blocks/builtin-blocks.js
 *
 * 内置块注册。当前只把剧情优化原硬编码的 sulv1-4 迁过来，作为新流水线的首批
 * 静态块——既验证 substitution 流程正常，又保留原行为字节级一致。
 *
 * 旧位置：core/summarizer.js 中 processPlotOptimization 的硬编码 replacements。
 */

import { register } from './registry.js';

let initialized = false;

export function registerBuiltinBlocks() {
    if (initialized) return;
    initialized = true;

    // 剧情优化（processPlotOptimization）的四个速率占位符
    register({
        id: 'plotOpt.sulv1',
        placeholder: 'sulv1',
        context: 'plotOptimization',
        generator: { type: 'static', valueKey: 'plotOpt_rateMain', defaultValue: 1.0 },
        name: '主线剧情速率',
        order: 1,
    });
    register({
        id: 'plotOpt.sulv2',
        placeholder: 'sulv2',
        context: 'plotOptimization',
        generator: { type: 'static', valueKey: 'plotOpt_ratePersonal', defaultValue: 1.0 },
        name: '个人线速率',
        order: 2,
    });
    register({
        id: 'plotOpt.sulv3',
        placeholder: 'sulv3',
        context: 'plotOptimization',
        generator: { type: 'static', valueKey: 'plotOpt_rateErotic', defaultValue: 1.0 },
        name: '速率3（留空）',
        order: 3,
    });
    register({
        id: 'plotOpt.sulv4',
        placeholder: 'sulv4',
        context: 'plotOptimization',
        generator: { type: 'static', valueKey: 'plotOpt_rateCuckold', defaultValue: 1.0 },
        name: '速率4（留空）',
        order: 4,
    });
}
