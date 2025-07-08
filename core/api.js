import { extension_settings, getContext } from "/scripts/extensions.js";
import { characters } from "/script.js";
import { world_names } from "/scripts/world-info.js";
import { extensionName } from "../utils/settings.js";
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

// =========================================================================

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
  console.groupCollapsed(
    `[Amily2号-优化任务] ${new Date().toLocaleTimeString()}`,
  );
  console.time("优化任务总耗时");

  const settings = extension_settings[extensionName];
  if (!settings.apiUrl || !settings.apiUrl.trim()) {
    toastr.error("API URL 未配置。", "API错误");
    console.timeEnd("优化任务总耗时");
    console.groupEnd();
    return null;
  }

  try {
    const userLatestMessage =
      previousMessages.length > 0
        ? previousMessages[previousMessages.length - 1]
        : null;

    let textToOptimize = latestMessage.mes;
    if (userLatestMessage && userLatestMessage.is_user) {
      console.log("【陛下最新圣旨】:", userLatestMessage.mes);
    }
    console.log("【待优化原文 (Amily回复)】:", textToOptimize);
    const initialContentMatch = latestMessage.mes.match(
      /<content>([\s\S]*?)<\/content>/,
    );
    if (initialContentMatch) {
      textToOptimize = initialContentMatch[1].trim();
    }

    let worldbookContent = "";
    if (settings.worldbookEnabled) {
      console.time("世界书调阅耗时");
      let combinedContents = [];
      const context = getContext();
      const character = context.characters[context.characterId];
      const characterLorebookName = character?.data?.extensions?.world;
      if (
        characterLorebookName &&
        world_names.includes(characterLorebookName)
      ) {
        const characterLore = await getCombinedWorldbookContent(
          characterLorebookName,
        );
        if (characterLore) {
          worldbookContent = characterLore; // 将角色世界书内容赋给主变量
          combinedContents.push(`角色主档案(${characterLorebookName})`);
        }
      }
      const chatIdentifier = await getChatIdentifier();
      const summaryLoreEntry = await findLatestSummaryLore(
        DEDICATED_LOREBOOK_NAME,
        chatIdentifier,
      );
      if (summaryLoreEntry && summaryLoreEntry.content) {
        combinedContents.push(`Amily2号自动总结档案`);
      }
      if (combinedContents.length > 0) {
        console.log(
          `[情报部] 已装载世界书内容: ${combinedContents.join("、 ")}`,
        );
      }
      console.timeEnd("世界书调阅耗时");
    }

    console.groupCollapsed("Amily2号-统一情报卷宗");
    let userCommand = "请根据以下信息，执行你的多任务指令：\n\n";
    const lastUserMessage =
      previousMessages.length > 0 &&
      previousMessages[previousMessages.length - 1].is_user
        ? previousMessages[previousMessages.length - 1]
        : null;
    const historyMessages = lastUserMessage
      ? previousMessages.slice(0, -1)
      : previousMessages;

    const history = historyMessages
      .map((m) => `${m.is_user ? "陛下" : "姐姐Amily"}: ${m.mes}`)
      .join("\n");

    if (history) {
      console.log("【历史对话】已装载");
      userCommand += `[近期对话历史]:\n${history}\n\n---\n`;
    }
    if (worldbookContent) {
      console.log("【世界书】已装载");
      userCommand += `[参考档案总集]:\n${worldbookContent}\n\n---\n`;
    }
    if (settings.mainPrompt && settings.mainPrompt.trim()) {
      console.log("【指令】已附加破限提示词");
      userCommand += `[最高优先级指令]:\n${settings.mainPrompt}\n\n---\n`;
    }

    let currentInteractionContent = "";
    if (lastUserMessage) {
      currentInteractionContent = `陛下: ${lastUserMessage.mes}\n姐姐Amily: ${textToOptimize}`;
    } else {
      currentInteractionContent = textToOptimize;
    }
    userCommand += `[待处理的原文]:\n${currentInteractionContent}`;
    let finalSystemPrompt = settings.systemPrompt;
    console.log("【规则】已附加系统提示词 (预设提示词)");
    if (settings.outputFormatPrompt && settings.outputFormatPrompt.trim()) {
      console.log("【格式】已附加优化内容格式提示词");
      finalSystemPrompt += `\n\n[输出格式指令]:\n你必须严格遵循以下格式来构建<content>标签内的所有内容：\n${settings.outputFormatPrompt}`;
    }
    if (
      settings.summarizationEnabled &&
      settings.summarizationPrompt &&
      settings.summarizationPrompt.trim()
    ) {
      console.log("【总结】已附加总结提示词");
      finalSystemPrompt += `\n\n[总结附加指令]:\n${settings.summarizationPrompt}`;
    }
    console.groupEnd();

    const messages = [
      { role: "system", content: finalSystemPrompt },
      { role: "user", content: userCommand },
    ];

    console.time("API请求耗时");
    let apiUrl = settings.apiUrl.trim();
    if (!apiUrl.endsWith("/chat/completions")) {
      if (apiUrl.endsWith("/v1")) apiUrl += "/chat/completions";
      else if (apiUrl.endsWith("/")) apiUrl += "v1/chat/completions";
      else apiUrl += "/v1/chat/completions";
    }
    const headers = { "Content-Type": "application/json" };
    if (settings.apiKey) headers["Authorization"] = `Bearer ${settings.apiKey}`;
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        model: settings.model,
        messages: messages,
        max_tokens: settings.maxTokens,
        temperature: settings.temperature,
        stream: false,
      }),
    });
    console.timeEnd("API请求耗时");

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `API请求失败: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }
    const data = await response.json();
    const rawContent = data.choices?.[0]?.message?.content;
    if (!rawContent) {
      console.timeEnd("优化任务总耗时");
      console.groupEnd();
      return null;
    }

    const separator = "###AMILY2-SUMMARY###";
    let optimizedContent = rawContent;
    let summary = null;
    if (rawContent.includes(separator)) {
      const parts = rawContent.split(separator);
      optimizedContent = parts[0].trim();
      summary = parts[1] ? parts[1].trim() : null;
    }

    if (summary) {
      console.groupCollapsed("Amily2号-生成总结");
      console.log(summary);
      console.groupEnd();
    }

    console.timeEnd("优化任务总耗时");
    console.groupEnd();
    return { optimizedContent, summary };
  } catch (error) {
    console.error(`[Amily2-情报解析官] 发生严重错误: ${error.message}`);
    toastr.error(`API调用失败: ${error.message}`, "Amily2号");
    console.timeEnd("优化任务总耗时");
    console.groupEnd();
    return null;
  }
}
