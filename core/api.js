import { extension_settings, getContext } from "/scripts/extensions.js";
import { characters } from "/script.js";
import { world_names } from "/scripts/world-info.js";
import { extensionName } from "../utils/settings.js";
import { extractContentByTag, replaceContentByTag, extractFullTagBlock } from '../utils/tagProcessor.js';
import {
  getCombinedWorldbookContent,
  findLatestSummaryLore,
  DEDICATED_LOREBOOK_NAME,
  getChatIdentifier,
} from "./lore.js";


const UPDATE_CHECK_URL =
  "https://raw.githubusercontent.com/Wx-2025/ST-Amily2-Chat-Optimisation/refs/heads/main/amily2_update_info.json";


export async function checkForUpdates() {
    if (!UPDATE_CHECK_URL || UPDATE_CHECK_URL.includes('YourUsername')) {
        console.log('[Amily2号-外交部] 任务取消：陛下尚未配置情报来源URL。');
        return null;
    }


    try {
        console.log('[Amily2号-外交部] 已派遣使者前往云端获取最新情报...');
        const response = await fetch(UPDATE_CHECK_URL, {
            method: 'GET',
            cache: 'no-store',
            mode: 'cors'
        });



        if (!response.ok) {
            throw new Error(`远方服务器响应异常，状态: ${response.status}`);
        }

        const data = await response.json();
        console.log('[Amily2号-外交部] 情报已成功获取并解析。');
        return data;

    } catch (error) {
        console.error('[Amily2号-外交部] 紧急军情：外交任务失败！', error);
        return null;
    }
}


let isFetchingModels = false;

export async function fetchSupportedModels() {
  const apiUrl = $("#amily2_api_url").val().trim();
  const apiKey = $("#amily2_api_key").val().trim();

  if (!apiUrl) {
    toastr.error("请先配置API URL", "获取模型失败");
    return [];
  }
  if (isFetchingModels) {
    toastr.info("正在获取模型列表，请稍候...", "获取模型");
    return [];
  }

  isFetchingModels = true;
  $("#amily2_refresh_models")
    .prop("disabled", true)
    .html('<i class="fas fa-spinner fa-spin"></i> 加载中');

  try {
    let modelListUrl;
    if (apiUrl.includes("/v1/chat/completions")) {
      modelListUrl = apiUrl.replace("/v1/chat/completions", "/v1/models");
    } else if (apiUrl.endsWith("/v1")) {
      modelListUrl = `${apiUrl}/models`;
    } else if (apiUrl.endsWith("/")) {
      modelListUrl = `${apiUrl}v1/models`;
    } else {
      modelListUrl = `${apiUrl}/v1/models`;
    }

    console.log("[更新] 模型列表请求地址:", modelListUrl);

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    if (modelListUrl.includes("love.qinyan.xyz")) {
      headers["X-Custom-Proxy"] = "Amily2-ChatPlugin";
      headers["Origin"] = window.location.origin;
    }

    const response = await fetch(modelListUrl, {
      method: "GET",
      headers: headers,
      mode: "cors",
      credentials: "omit",
    });
    if (!response.ok) {
      let errorBody = "";
      try {
        const errorResponse = await response.json();
        errorBody = errorResponse.error?.message
          ? ` - ${errorResponse.error.message}`
          : await response.text();
      } catch (e) {
        errorBody = "无法解析错误响应";
      }
      throw new Error(
        `API返回错误: ${response.status} ${response.statusText}${errorBody}`,
      );
    }

    const data = await response.json();
    let models = [];
    if (Array.isArray(data)) {
      models = data.map((m) => m.id || m);
    } else if (data.data && Array.isArray(data.data)) {
      models = data.data.map((m) => m.id);
    } else if (data.models && Array.isArray(data.models)) {
      models = data.models;
    } else {
      throw new Error("未知的模型列表格式");
    }

    const availableModels = models.filter(
      (m) =>
        !m.includes("embed") &&
        !m.includes("search") &&
        !m.includes("similarity") &&
        !m.includes("audio"),
    );
    availableModels.sort();

    console.log(
      `获取模型列表成功 (${availableModels.length}个):`,
      availableModels,
    );

    toastr.success(
      `成功获取 ${availableModels.length} 个可用模型`,
      "模型加载完成",
    );
    return availableModels;
  } catch (error) {
    console.error("[错误详情] 获取模型列表失败:", {
      message: error.message,
      stack: error.stack,
    });
    if (error.message.includes("Failed to fetch"))
      toastr.error("网络连接失败，请检查API地址和网络状态", "网络错误");
    else if (error.message.includes("401") || error.message.includes("403"))
      toastr.error("API密钥无效或权限不足", "认证错误");
    else if (error.message.includes("404"))
      toastr.error(
        "API端点不存在，请确保URL指向OpenAI兼容的/v1/models端点",
        "端点错误",
      );
    else toastr.error(`获取模型失败: ${error.message}`, "错误");
    return [];
  } finally {
    isFetchingModels = false;
    $("#amily2_refresh_models")
      .prop("disabled", false)
      .html('<i class="fas fa-sync-alt"></i> 刷新模型');
  }
}

export async function checkAndFixWithAPI(latestMessage, previousMessages) {
    if (window.AMILY2_SYSTEM_PARALYZED === true) {
        console.error("[Amily2-制裁] 系统完整性已受损，所有外交活动被无限期中止。");
        return null;
    }

    const settings = extension_settings[extensionName];
    const isOptimizationEnabled = settings.optimizationEnabled;
    const isSummarizationEnabled = settings.summarizationEnabled;

    if (!isOptimizationEnabled && !isSummarizationEnabled) {
        return null;
    }

    if (!settings.apiUrl || !settings.apiUrl.trim()) {
        toastr.error("API URL 未配置。", "Amily2-外交部");
        return null;
    }

    console.groupCollapsed(`[Amily2号-外交任务] ${new Date().toLocaleTimeString()} | 模式: ${isOptimizationEnabled ? '优化' : ''}${isSummarizationEnabled ? (isOptimizationEnabled ? '+总结' : '仅总结') : ''}`);
    console.time("外交任务总耗时");

    try {
        const originalFullMessage = latestMessage.mes;
        const targetTag = settings.optimizationTargetTag || 'content';
        let textToProcess;

        if (isOptimizationEnabled) {
            textToProcess = extractFullTagBlock(originalFullMessage, targetTag);
            if (!textToProcess || extractContentByTag(textToProcess, targetTag)?.trim() === '') {
                 console.log(`[Amily2-外交部] 目标标签 <${targetTag}> 未找到或为空，优化任务已跳过。`);
                 textToProcess = originalFullMessage;
                 if (!isSummarizationEnabled) {
                    console.timeEnd("外交任务总耗时");
                    console.groupEnd();
                    return { optimizedContent: originalFullMessage, summary: null };
                }
            }
        } else {
            textToProcess = originalFullMessage;
        }

        const lastUserMessage = previousMessages.length > 0 && previousMessages[previousMessages.length - 1].is_user ? previousMessages[previousMessages.length - 1] : null;
        const historyMessages = lastUserMessage ? previousMessages.slice(0, -1) : previousMessages;
        const history = historyMessages.map(m => (m.mes && m.mes.trim() ? `${m.is_user ? "陛下" : "姐姐Amily"}: ${m.mes.trim()}` : null)).filter(Boolean).join("\n");
        let worldbookContent = "";
        if (settings.worldbookEnabled) {
            const context = getContext();
            const character = characters[context.characterId];
            if (character?.data?.extensions?.world) {
                worldbookContent = await getCombinedWorldbookContent(character.data.extensions.world);
            }
        }
        const messages = [];
        if (settings.mainPrompt?.trim()) { messages.push({ role: "system", content: settings.mainPrompt.trim() }); }
        if (isOptimizationEnabled) { if (settings.systemPrompt?.trim()) messages.push({ role: "system", content: settings.systemPrompt.trim() }); }
        if (isOptimizationEnabled && isSummarizationEnabled) {
            const combinedFormatAndSummaryPrompt = `[输出格式与附加任务指令]:\n你的输出必须严格遵循以下完整结构：\n\n${textToProcess.replace(extractContentByTag(textToProcess, targetTag), '这里是优化后的文本内容...')}\n\n###AMILY2-SUMMARY###\n\n这里是根据对话生成的剧情摘要...\n\n[总结核心要求]:\n${settings.summarizationPrompt?.trim() || '生成一段简短的剧情摘要。'}`.trim();
            messages.push({ role: "system", content: combinedFormatAndSummaryPrompt });
        } else if (!isOptimizationEnabled && isSummarizationEnabled) {
            const summaryEdict = `请严格遵循以下指令：基于所有提供的背景和对话内容，生成一段精炼的剧情摘要。直接输出摘要文本，不要包含任何多余的解释、标签或前缀。\n\n[总结核心要求]:\n${settings.summarizationPrompt.trim()}`;
            messages.push({ role: "system", content: summaryEdict });
        }
        if (worldbookContent) messages.push({ role: "user", content: `[世界书档案]:\n${worldbookContent}` });
        if (history) messages.push({ role: "user", content: `[上下文参考]:\n${history}` });
        let currentInteractionContent = lastUserMessage ? `陛下: ${lastUserMessage.mes}\n姐姐Amily: ${textToProcess}` : textToProcess;
        messages.push({ role: "user", content: `[核心处理内容]:\n${currentInteractionContent}` });
		        console.groupCollapsed("[Amily2号-最终国书内容 (发往AI)]");
        console.dir(messages);
        console.groupEnd();


        let apiUrl = settings.apiUrl.trim();
        if (!apiUrl.endsWith('/v1/chat/completions')) { apiUrl = new URL('/v1/chat/completions', apiUrl).href; }
        const response = await fetch(apiUrl, { method: "POST", headers: { "Content-Type": "application/json", ...(settings.apiKey && {"Authorization": `Bearer ${settings.apiKey}`})}, body: JSON.stringify({ model: settings.model, messages, max_tokens: settings.maxTokens, temperature: settings.temperature, stream: false }) });

        if (!response.ok) { throw new Error(`API请求失败: ${response.status} ${response.statusText} - ${await response.text()}`); }
        const data = await response.json();
        const rawContent = data.choices?.[0]?.message?.content;
        if (!rawContent) { return null; }
        console.groupCollapsed("[Amily2号-原始回复]");
        console.log(rawContent);
        console.groupEnd();
        let finalMessage = originalFullMessage;
        let summary = null;

        if (isOptimizationEnabled && isSummarizationEnabled) {
            const separator = "###AMILY2-SUMMARY###";
            const parts = rawContent.split(separator);
            const optimizedBlockFromAI = parts[0]?.trim();
            summary = parts[1]?.trim() || null;
            if (optimizedBlockFromAI) { const purifiedTextFromB = extractContentByTag(optimizedBlockFromAI, targetTag); if (purifiedTextFromB?.trim()) { finalMessage = replaceContentByTag(originalFullMessage, targetTag, purifiedTextFromB); } }
        } else if (isOptimizationEnabled) {
            const purifiedTextFromB = extractContentByTag(rawContent, targetTag); if (purifiedTextFromB?.trim()) { finalMessage = replaceContentByTag(originalFullMessage, targetTag, purifiedTextFromB); }
        } else {
            summary = rawContent.trim();
        }



        const result = {
            optimizedContent: finalMessage,
            summary: summary,
        };


        if (summary && isSummarizationEnabled) {
            result.loreSettings = {
                activationMode: settings.loreActivationMode,
                insertionPosition: settings.loreInsertionPosition,
                depth: settings.loreDepth,
                keywords: settings.loreKeywords,
                target: settings.lorebookTarget,
            };
            console.log('[Amily2-外交部] 已将史册律法附加至国书，准备发往下一站。', result.loreSettings);
        }

        // ====================================================================

        console.timeEnd("外交任务总耗时");
        console.groupEnd();
        return result;

    } catch (error) {
        console.error(`[Amily2-外交部] 发生严重错误:`, error);
        toastr.error(`Amily2号任务失败: ${error.message}`, "严重错误");
        console.timeEnd("外交任务总耗时");
        console.groupEnd();
        return null;
    }
}

//以此标记
//以此标记
