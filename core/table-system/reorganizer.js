import { getContext, extension_settings } from "/scripts/extensions.js";
import { saveChat } from "/script.js";
import { renderTables } from '../../ui/table-bindings.js';
import { extensionName } from "../../utils/settings.js";
import { convertTablesToCsvString, saveStateToMessage, getMemoryState, updateTableFromText, getBatchFillerRuleTemplate, getBatchFillerFlowTemplate } from './manager.js';
import { getPresetPrompts, getMixedOrder } from '../../PresetSettings/index.js';
import { callAI, generateRandomSeed } from '../api.js';

export async function reorganizeTableContent() {
    const settings = extension_settings[extensionName];

    if (window.AMILY2_SYSTEM_PARALYZED === true) {
        console.error("[Amily2-制裁] 系统完整性已受损，所有外交活动被无限期中止。");
        return;
    }

    const { apiUrl, apiKey, model, temperature, maxTokens, forceProxyForCustomApi } = settings;
    if (!apiUrl || !model) {
        toastr.error("主API的URL或模型未配置，重新整理功能无法启动。", "Amily2-重新整理");
        return;
    }

    try {
        toastr.info('正在重新整理表格内容...', 'Amily2-重新整理');
        
        const currentTableDataString = convertTablesToCsvString();
        if (!currentTableDataString.trim()) {
            toastr.warning('当前没有表格内容需要整理。', 'Amily2-重新整理');
            return;
        }

        const order = getMixedOrder('reorganizer') || [];
        const presetPrompts = getPresetPrompts('reorganizer');
        
        const messages = [
            { role: 'system', content: generateRandomSeed() }
        ];

        const ruleTemplate = getBatchFillerRuleTemplate();
        const flowTemplate = getBatchFillerFlowTemplate();
        const finalFlowPrompt = flowTemplate.replace('{{{Amily2TableData}}}', currentTableDataString);

        let promptCounter = 0; 
        for (const item of order) {
            if (item.type === 'prompt') {
                if (presetPrompts && presetPrompts[promptCounter]) {
                    messages.push(presetPrompts[promptCounter]);
                    promptCounter++; 
                }
            } else if (item.type === 'conditional') {
                switch (item.id) {
                    case 'flowTemplate':
                        messages.push({ role: "system", content: finalFlowPrompt });
                        break;
                    case 'thinkingFramework':
                        messages.push({ role: "system", content: `# 表格内容重新整理思考框架
## 核心原则
1. 保持数据完整性：不删除有价值的信息
2. 优化数据结构：合并重复、统一格式
3. 提升可读性：逻辑排序、精简表达
4. 确保准确性：验证信息一致性

## 思考流程 (<thinking></thinking>)
请严格按此框架思考并在<thinking>标签内输出：
<thinking>
1. 【数据概览分析】
   - 表格总数：当前有多少个表格？
   - 数据规模：每个表格的行数和列数
   - 内容类型：识别主要的数据类别

2. 【重复内容检测】
   - 行级别重复：完全相同的行
   - 列级别重复：相似或冗余的列
   - 内容重复：相同信息的不同表述

3. 【格式统一需求】
   - 时间格式：统一
   - 地点格式：统一
   - 状态标记：使用标准词汇(进行中/已完成/已取消)

4. 【逻辑重组方案】
   - 时间顺序：按事件发生的先后排序
   - 重要性排序：关键信息优先
   - 类别分组：相似内容归类

5. 【数据清理策略】
   - 无效数据：空白、无意义的内容
   - 过时信息：已被后续信息覆盖的内容
   - 冗余描述：可以合并的相似描述

6. 【最终验证检查】
   - 完整性：确保所有重要信息保留
   - 一致性：检查数据间的逻辑关系
   - 准确性：验证整理后的内容正确
</thinking>
<Amily2Edit>
<!-- 
在这里输出你的表格操作指令
 -->
</Amily2Edit>
<finsh>The table reorganization work has been completed.</finsh>` });
                        break;
                }
            }
        }

        console.groupCollapsed(`[Amily2 重新整理] 即将发送至 API 的内容`);
        console.dir(messages);
        console.groupEnd();

        const rawContent = await callAI(messages);

        if (!rawContent) {
            console.error('[Amily2-重新整理] 未能获取AI响应内容。');
            return;
        }

        console.log("[Amily2号-重新整理-原始回复]:", rawContent);
        updateTableFromText(rawContent);
        renderTables();
        
        toastr.success('表格内容重新整理完成！', 'Amily2-重新整理');
        const currentContext = getContext();
        if (currentContext.chat && currentContext.chat.length > 0) {
            saveChat();
        }

    } catch (error) {
        console.error('[Amily2-重新整理] 发生错误:', error);
        toastr.error(`重新整理失败: ${error.message}`, 'Amily2-重新整理');
    }
}
