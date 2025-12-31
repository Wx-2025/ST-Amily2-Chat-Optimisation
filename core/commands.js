import { getContext, extension_settings } from "/scripts/extensions.js";
import { saveChatConditional, reloadCurrentChat } from "/script.js";
import { extensionName } from "../utils/settings.js";
import { SlashCommand } from "/scripts/slash-commands/SlashCommand.js";
import { SlashCommandParser } from "/scripts/slash-commands/SlashCommandParser.js";
import { checkAndFixWithAPI } from "./api.js";
import { amilyHelper } from './tavern-helper/main.js';

async function checkLatestMessage() {
  const context = getContext();
  const chat = context.chat || [];

  if (!chat || chat.length === 0) {
    console.log("[Amily2-命令检查器] 没有聊天记录。");
    return { message: null, previousMessages: [] };
  }

  const latestMessage = chat[chat.length - 1];

  console.log("[Amily2-命令检查器] 正在侦测消息:", {
    isUser: latestMessage.is_user,
    messagePreview: latestMessage.mes?.substring(0, 50) + "...",
  });

  if (latestMessage.is_user) {
    console.log("[Amily2-命令检查器] 目标为用户消息，跳过。");
    return { message: latestMessage, previousMessages: [] };
  }

  const settings = extension_settings[extensionName];
  const contextCount = settings.contextMessages || 2;
  const startIndex = Math.max(0, chat.length - contextCount - 1);
  const previousMessages = chat.slice(startIndex, chat.length - 1);

  console.log("[Amily2-命令检查器] 已获取上下文消息:", {
    count: previousMessages.length,
  });

  return { message: latestMessage, previousMessages };
}

async function checkCommand() {
  const settings = extension_settings[extensionName];
  if (!settings.apiUrl) {
    toastr.error("请先配置API URL", "命令检查器");
    return "";
  }
  const checkResult = await checkLatestMessage();
  if (!checkResult.message || checkResult.message.is_user) {
    toastr.info("最新消息是用户消息，无需检查", "命令检查器");
    return "";
  }
  toastr.info("正在使用API检查回复...", "命令检查器");
  const result = await checkAndFixWithAPI(
    checkResult.message,
    checkResult.previousMessages,
  );
  if (
    result &&
    result.optimizedContent &&
    result.optimizedContent !== checkResult.message.mes
  ) {
    toastr.warning("检测到问题，建议使用修复功能", "命令检查器");
  } else {
    toastr.success("未检测到问题", "命令检查器");
  }
  return "";
}


export async function fixCommand() {
  const settings = extension_settings[extensionName];
  if (!settings.apiUrl) {
    toastr.error("请先配置API URL", "命令检查器");
    return "";
  }
  const context = getContext();
  const chat = context.chat;
  if (!chat || chat.length === 0) {
    toastr.info("没有可修复的消息", "命令检查器");
    return "";
  }
  const latestMessage = chat[chat.length - 1];
  if (latestMessage.is_user) {
    toastr.info("最新消息是用户消息，无需修复", "命令检查器");
    return "";
  }
  const contextCount = settings.contextMessages || 2;
  const startIndex = Math.max(0, chat.length - 1 - contextCount);
  const previousMessages = chat.slice(startIndex, chat.length - 1);
  toastr.info("正在检查并修复回复...", "命令检查器");
  const result = await checkAndFixWithAPI(latestMessage, previousMessages);
  if (
    result &&
    result.optimizedContent &&
    result.optimizedContent !== latestMessage.mes
  ) {
    const messageId = chat.length - 1;
    await amilyHelper.setChatMessage(
        { message: result.optimizedContent },
        messageId,
        { refresh: 'display_and_render_current' }
    );
    toastr.success("回复已修复", "命令检查器");
  } else {
    toastr.info("未检测到需要修复的问题", "命令检查器");
  }
  return "";
}

export async function testReplyChecker() {
  const settings = extension_settings[extensionName];
  if (!settings.apiUrl) {
    toastr.error("请先配置API URL", "命令检查器");
    return "";
  }
  const context = getContext();
  const chat = context.chat;
  if (!chat || chat.length < 2) {
    toastr.warning("需要至少2条消息才能测试", "命令检查器");
    return "";
  }
  let testMessage = null;
  for (let i = chat.length - 2; i >= 0; i--) {
    if (!chat[i].is_user) {
      testMessage = chat[i].mes;
      break;
    }
  }
  if (!testMessage) {
    toastr.warning("没有找到可用于测试的AI消息", "命令检查器");
    return "";
  }
  const lastMessage = chat[chat.length - 1];
  if (lastMessage.is_user) {
    toastr.warning("最后一条消息是用户消息，无法测试", "命令检查器");
    return "";
  }
  const originalMessage = lastMessage.mes;
  lastMessage.mes = testMessage + "\n\n" + testMessage;
  toastr.info("正在使用API测试检测功能...", "命令检查器");
  const contextCount = settings.contextMessages || 2;
  const startIndex = Math.max(0, chat.length - contextCount - 1);
  const previousMessages = chat.slice(startIndex, chat.length - 1);
  const result = await checkAndFixWithAPI(lastMessage, previousMessages);
  lastMessage.mes = originalMessage;
  if (
    result &&
    result.optimizedContent &&
    result.optimizedContent !== testMessage + "\n\n" + testMessage
  ) {
    toastr.success("测试成功！API检测到重复内容并提供了修复建议", "命令检查器");
  } else {
    toastr.warning(
      "测试结果：API未检测到问题，请检查API配置或提示词",
      "命令检查器",
    );
  }
  return "";
}

async function triggerSendButton() {
  // 模拟点击发送按钮
  const sendButton = document.getElementById('send_but');
  if (sendButton) {
    sendButton.click();
    console.log("[Amily2-触发器] 已触发发送按钮");
    return "";
  } else {
    console.warn("[Amily2-触发器] 未找到发送按钮");
    toastr.warning("未找到发送按钮", "触发器");
    return "";
  }
}

export async function registerSlashCommands() {
  try {
    if (
      typeof SlashCommand === "undefined" ||
      typeof SlashCommandParser === "undefined"
    ) {
      console.error(
        "[Amily2] 致命错误：SlashCommand 或 SlashCommandParser 模块未能加载。",
      );
      return;
    }
    SlashCommandParser.addCommandObject(
      SlashCommand.fromProps({
        name: "check-reply",
        callback: checkCommand,
        helpString: "检查最新的AI回复是否有问题",
      }),
    );
    console.log("[Amily2-新诏] /check-reply 命令已成功颁布。");

    SlashCommandParser.addCommandObject(
      SlashCommand.fromProps({
        name: "fix-reply",
        callback: fixCommand,
        helpString: "修复最新的AI回复中的问题",
      }),
    );
    console.log("[Amily2-新诏] /fix-reply 命令已成功颁布。");

    SlashCommandParser.addCommandObject(
      SlashCommand.fromProps({
        name: "test-reply-checker",
        callback: testReplyChecker,
        helpString: "测试聊天回复检查器功能",
      }),
    );
    console.log("[Amily2-新诏] /test-reply-checker 命令已成功颁布。");

    SlashCommandParser.addCommandObject(
      SlashCommand.fromProps({
        name: "trigger",
        callback: triggerSendButton,
        helpString: "触发发送按钮 (用于自动发送消息)",
      }),
    );
    console.log("[Amily2-新诏] /trigger 命令已成功颁布。");
  } catch (e) {
    console.error("[Amily2] 命令注册过程中发生意外错误:", e);
  }
}
