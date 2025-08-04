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
import { checkAndFixWithAPI as summarizerCheckAndFix } from './summarizer.js';
 
// 导入 Google 适配器和轮询管理器
import {
  isGoogleEndpoint,
  convertToGoogleRequest,
  parseGoogleResponse,
  buildGoogleApiUrl
} from '../core/utils/googleAdapter.js';
 
import {
  intelligentPoll,
  createGooglePollingTask,
  progressTracker
} from '../core/utils/pollingManager.js';


let ChatCompletionService = undefined;
try {
    const module = await import('/scripts/custom-request.js');
    ChatCompletionService = module.ChatCompletionService;
    console.log('[Amily2号-外交部] 已成功召唤“皇家信使”(ChatCompletionService)。');
} catch (e) {
    console.warn("[Amily2号-外交部] 未能召唤“皇家信使”，部分高级功能（如Claw代理）将受限。请考虑更新SillyTavern版本。", e);
}
 
const UPDATE_CHECK_URL =
  "https://raw.githubusercontent.com/Wx-2025/ST-Amily2-Chat-Optimisation/refs/heads/main/amily2_update_info.json";

const MESSAGE_BOARD_URL =
  "https://raw.githubusercontent.com/Wx-2025/ST-Amily2-Chat-Optimisation/refs/heads/main/amily2_message_board.json";
 
export async function fetchMessageBoardContent() {
    if (!MESSAGE_BOARD_URL) {
        console.log('[Amily2号-内务府] 任务取消：陛下尚未配置留言板URL。');
        return null;
    }
    try {
        const response = await fetch(MESSAGE_BOARD_URL, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`服务器响应异常: ${response.status}`);
        }
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('[Amily2号-内务府] 获取留言板内容失败:', error);
        return null;
    }
}
 
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
	  const settings = extension_settings[extensionName];
  if (settings && settings.forceProxyForCustomApi) {
    console.log('[Amily2号-使节团] 已启用“皇家密道”模式，跳过模型列表获取。请手动输入模型ID并保存。');
    toastr.info("已启用手动模式，请直接输入模型ID。", "模式切换");

    const $selector = $("#amily2_model");
    $selector.empty().append($('<option>', { value: '', text: '手动模式已启用' }));
    return []; // 直接结束任务，不再执行后续的网络请求
  }
  if (window.AMILY2_LOCK_MODEL_FETCHING) {
    console.warn("[Amily2号-使节团] 上次任务尚未完成，本次任务取消。");
    toastr.info("上次任务尚未完成，请稍后再试。", "任务排队中");
    return [];
  }
  
  window.AMILY2_LOCK_MODEL_FETCHING = true;
  
  try {
    const apiUrl = $("#amily2_api_url").val().trim();
    const apiKeysString = $("#amily2_api_key").val().trim();
    const $button = $("#amily2_refresh_models");
    const $selector = $("#amily2_model");
 
    if (!apiUrl || !apiKeysString) {
      toastr.error("陛下，请先赐予 API 地址与至少一枚 API Key。", "配置缺失");
      return [];
    }
 
    $button.prop("disabled", true).html('<i class="fas fa-spinner fa-spin"></i> 加载中');
    $selector.empty().append($('<option>', { value: '', text: '正在轮换使节团获取模型...' }));
 
    const apiKeys = apiKeysString.split(',').map(k => k.trim()).filter(Boolean);
    if (apiKeys.length === 0) {
      toastr.error("陛下，您提供的 API Key 无效或为空。", "API Key无效");
      $selector.empty().append($('<option>', { value: '', text: 'API Key无效' }));
      return [];
    }
 
    const errorLog = [];
    let successResults = [];
 
    for (let i = 0; i < apiKeys.length; i++) {
      const currentApiKey = apiKeys[i];
      console.log(`[Amily2号-使节团] 派遣第 ${i + 1}/${apiKeys.length} 位使节 (Key: ...${currentApiKey.slice(-4)}) ...`);
      
      try {
        let modelsApiUrl;
        const baseUrlObject = new URL(apiUrl);
        const isGoogleAPI = isGoogleEndpoint(apiUrl);
 
        // 处理 Google API 端点
        if (isGoogleAPI) {
          if (baseUrlObject.hostname.includes("generativelanguage.googleapis.com") ||
              baseUrlObject.hostname.includes("ai.google.dev")) {
            baseUrlObject.pathname = '/v1beta/models';
          } else if (baseUrlObject.hostname.includes("aiplatform.googleapis.com")) {
            baseUrlObject.pathname = '/v1beta/projects/locations/global/models';
          } else {
            throw new Error("无法识别的 Google API 端点");
          }
          modelsApiUrl = baseUrlObject.href;
        }
        // 处理 OpenAI 兼容端点
        else {
          let path = baseUrlObject.pathname;
          /*
          // 旧的逻辑 - 过于宽泛，会导致对Google兼容层URL错误地附加/v1
          if (path.endsWith('/v1/chat/completions')) {
            path = path.substring(0, path.length - '/chat/completions'.length);
          } else if (path.endsWith('/v1/')) {
            path = path.slice(0, -1);
          } else if (!path.endsWith('/v1')) {
            path = path.replace(/\/$/, '') + '/v1';
          }
          */

          // 新逻辑：区分处理 Google OpenAI 兼容层和通用 OpenAI 接口
          if (path.toLowerCase().includes('/openai')) {
            // 对于 Google 的兼容层 (e.g., /v1beta/openai)，我们假定它就是根路径
            // 直接附加 /models，并确保没有尾部斜杠
            path = path.replace(/\/$/, '');
          } else {
            // 原有的、通用的 OpenAI 兼容端点逻辑
            if (path.endsWith('/v1/chat/completions')) {
              path = path.substring(0, path.length - '/chat/completions'.length);
            } else if (path.endsWith('/v1/')) {
              path = path.slice(0, -1);
            } else if (!path.endsWith('/v1')) {
              path = path.replace(/\/$/, '') + '/v1';
            }
          }
          baseUrlObject.pathname = path.replace(/\/$/, '') + '/models';
          modelsApiUrl = baseUrlObject.href;
        }
 
        console.log(`[Amily2号-外交部] 使节团尝试使用地址: ${modelsApiUrl}`);
        console.log(`[Amily2号-外交部] API 类型: ${isGoogleAPI ? 'Google' : 'OpenAI 兼容'}`);
 
        const headers = {
          "Content-Type": "application/json",
          Accept: "application/json"
        };
 
        // Google API 认证头处理
        if (isGoogleAPI) {
          console.log(`[Amily2号-使节团] 使用 Google API Key: ...${currentApiKey.slice(-4)}`);
          
          if (baseUrlObject.hostname.includes("generativelanguage.googleapis.com") || 
              baseUrlObject.hostname.includes("ai.google.dev")) {
            headers["X-goog-api-key"] = currentApiKey;
          } else if (baseUrlObject.hostname.includes("aiplatform.googleapis.com")) {
            headers["Authorization"] = `Bearer ${currentApiKey}`;
          }
        } 
        // OpenAI 兼容 API 认证头处理
        else {
          headers["Authorization"] = `Bearer ${currentApiKey}`;
        }
 
        // 自定义代理头
        if (modelsApiUrl.includes("love.qinyan.xyz")) {
          headers["X-Custom-Proxy"] = "Amily2-ChatPlugin";
          headers["Origin"] = window.location.origin;
        }
 
        const response = await fetch(modelsApiUrl, {
          method: "GET",
          headers: headers,
          mode: "cors",
          credentials: "omit",
        });
 
        if (!response.ok) {
          let errorBody = "";
          try {
            const jsonError = await response.json();
            errorBody = JSON.stringify(jsonError, null, 2);
          } catch {
            try { errorBody = await response.text(); } 
            catch (e) { errorBody = "<无法提取错误正文>"; }
          }
          throw new Error(`API返回错误: ${response.status} ${response.statusText}\n${errorBody}`);
        }
 
        const data = await response.json();
        let models = [];
        
        // Google API 模型解析
        if (isGoogleAPI) {
          if (data.models && Array.isArray(data.models)) {
            models = data.models.map(m => m.name);
          } else if (data.data && Array.isArray(data.data)) {
            models = data.data.map(m => m.name || m.id);
          } else if (Array.isArray(data)) {
            models = data.map(m => m.name);
          } else {
            throw new Error("未知的 Google 模型列表格式");
          }
        } 
        // OpenAI 兼容 API 模型解析
        else {
          if (Array.isArray(data)) {
            models = data.map((m) => m.id || m);
          } else if (data.data && Array.isArray(data.data)) {
            models = data.data.map((m) => m.id);
          } else if (data.models && Array.isArray(data.models)) {
            models = data.models.map(m => m.id);
          } else {
            throw new Error("未知的模型列表格式");
          }
        }
 
        // 过滤不需要的模型（嵌入/音频等）
        const availableModels = models
          .filter(m => typeof m === 'string')
          .filter(m => !m.toLowerCase().includes("embed"))
          .filter(m => !m.toLowerCase().includes("search"))
          .filter(m => !m.toLowerCase().includes("similarity"))
          .filter(m => !m.toLowerCase().includes("audio"))
          .filter(m => !m.toLowerCase().includes("code"))
          .filter(m => !m.toLowerCase().includes("whisper"));
 
        availableModels.sort((a, b) => a.localeCompare(b));
        console.log(`[Amily2号-使节团] 第 ${i + 1} 位使节成功带回 ${availableModels.length} 个模型！`);
 
        // 合并结果并过滤重复项
        successResults = [...new Set([...successResults, ...availableModels])];
        successResults.sort();
 
        if (isGoogleAPI) {
          toastr.success(`成功获取 ${availableModels.length} 个 Google 模型 (使用第 ${i + 1} 个Key)`, "任务成功");
        } else {
          toastr.success(`成功获取 ${availableModels.length} 个模型 (使用第 ${i + 1} 个Key)`, "任务成功");
        }
 
        // 不再继续尝试，返回成功结果
        break;
      } catch (error) {
        const errorMessage = `Key ...${currentApiKey.slice(-4)} 失败: ${error.message}`;
        console.error(`[Amily2号-使节团] 第 ${i + 1} 位使节任务失败:`, error);
        errorLog.push(errorMessage);
      }
    }
 
    if (successResults.length > 0) {
      console.log(`[Amily2号-使节团] 最终带回 ${successResults.length} 个可用模型`);
      toastr.info(`所有使节团任务完成，找到 ${successResults.length} 个可用模型`, "任务总结");
      return successResults;
    }
 
    toastr.error("所有使节均未能完成任务。详情请见控制台(F12)。", "外交任务失败");
    console.error("[Amily2号-使节团] 失败详情汇总:\n" + errorLog.join("\n"));
    return [];
    
  } catch (error) {
    console.error("[Amily2号-使节团] 全局错误:", error);
    toastr.error("模型获取失败: " + error.message, "系统错误");
    return [];
  } finally {
    window.AMILY2_LOCK_MODEL_FETCHING = false;
    const $button = $("#amily2_refresh_models");
    $button.prop("disabled", false).html('<i class="fas fa-sync-alt"></i> 刷新模型');
  }
}
 
export async function checkAndFixWithAPI(latestMessage, previousMessages) {
    // 将实现委托给 summarizer 模块
    return await summarizerCheckAndFix(latestMessage, previousMessages);
}
 
//以此标记
//以此标记
