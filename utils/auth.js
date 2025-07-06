
import { extension_settings } from "/scripts/extensions.js";
import { saveSettings } from "./settings.js";
import { updateUI } from "../ui/state.js";


export const pluginAuthStatus = {
  authorized: false,
  expired: false,
};

const PASSWORD_VALIDITY_DAYS = 7;

const AUTH_CONFIG = {
  expiryDate: new Date("2025-12-31"),
  validityDays: PASSWORD_VALIDITY_DAYS,
};


console.log(`[Amily2号] 密码有效期为: ${PASSWORD_VALIDITY_DAYS}天`);


function generateDynamicPassword(date = new Date()) {
  const seed = { a: 1103515245, c: 12345, m: 2147483647 };

  function customHash(input) {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      hash = (hash << 5) - hash + input.charCodeAt(i);
      hash |= 0;
    }
    return hash >>> 0;
  }

  const month = date.getMonth() + 1;
  const day = date.getDate();
  const year = date.getFullYear();
  const baseInput = `${month}-${day}-AMILY_${year}`;
  const str1 = `SD${customHash(baseInput)}`;
  const str2 = `V${customHash(str1)}`;

  function lcgRandom(params) {
    return function () {
      params.seed = (params.a*params.seed + params.c) % params.m;
      return params.seed;
    };
  }

  const combinedSeed = customHash(str2) % seed.m;
  const randFunc = lcgRandom({ ...seed, seed: combinedSeed });
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const segments = [];
  for (let segIdx = 0; segIdx < 3; segIdx++) {
    let segment = "";
    for (let i = 0; i < 4; i++) {
      const randValue = Math.abs(randFunc());
      segment += chars.charAt(randValue % chars.length);
    }
    segments.push(segment);
  }
  return segments.join("-");
}


export function getPasswordForDate(date = new Date()) {
  return generateDynamicPassword(date);
}


export function checkAuthorization() {
  const now = new Date();
  pluginAuthStatus.expired = now > AUTH_CONFIG.expiryDate;

  if (pluginAuthStatus.expired) {
    localStorage.removeItem("plugin_activated");
    localStorage.removeItem("plugin_auth_code");
    localStorage.removeItem("plugin_valid_until");
    console.log("[Amily2号] 检测到授权过期，已清理本地存储。");
  }

  const activated = localStorage.getItem("plugin_activated") === "true";
  const savedAuthCode = localStorage.getItem("plugin_auth_code");
  const validUntil = localStorage.getItem("plugin_valid_until");

  let withinValidityPeriod = false;
  if (validUntil) {
    const validUntilDate = new Date(validUntil);
    withinValidityPeriod = now <= validUntilDate;
    console.log(`[Amily2号] 授权有效期检查:
            当前时间: ${now.toISOString()}
            授权有效期至: ${validUntilDate.toISOString()}
            是否在有效期内: ${withinValidityPeriod}`);
  }

  let passwordMatches = false;
  if (savedAuthCode) {
    const today = new Date();
    for (let i = 0; i < AUTH_CONFIG.validityDays; i++) {
      const checkDate = new Date();
      checkDate.setDate(today.getDate() - i);
      const passwordForDay = getPasswordForDate(checkDate);
      if (savedAuthCode === passwordForDay) {
        passwordMatches = true;
        console.log(`[Amily2号] 密码匹配: ${savedAuthCode} 对应第${i + 1}天前`);
        break;
      }
    }
  }

  pluginAuthStatus.authorized =
    activated &&
    !pluginAuthStatus.expired &&
    passwordMatches &&
    withinValidityPeriod;

  return pluginAuthStatus.authorized;
}


export async function activatePluginAuthorization(authCode) {
  let isValidCode = false;
  const today = new Date();

  for (let i = 0; i < AUTH_CONFIG.validityDays; i++) {
    const checkDate = new Date();
    checkDate.setDate(today.getDate() - i);
    const passwordForDay = getPasswordForDate(checkDate);
    if (authCode === passwordForDay) {
      isValidCode = true;
      break;
    }
  }

  if (!isValidCode) {
    toastr.error("授权码无效", "激活失败");
    return false;
  }

  const now = new Date();
  if (now > AUTH_CONFIG.expiryDate) {
    toastr.error("授权已过期", "激活失败");
    return false;
  }

  const validUntil = new Date();
  validUntil.setDate(now.getDate() + AUTH_CONFIG.validityDays);
  localStorage.setItem("plugin_valid_until", validUntil.toISOString());
  localStorage.setItem("plugin_auth_code", authCode);
  localStorage.setItem("plugin_activated", "true");
  localStorage.setItem("plugin_auto_login", "true");

  toastr.success(
    `授权激活成功！${AUTH_CONFIG.validityDays}天内将自动登录。`,
    "Amily2号启用",
  );
  pluginAuthStatus.authorized = true;

  $("#auth_panel").slideUp(400, function () {
    $(".plugin-features").slideDown(400);
    updateUI();
  });

  extension_settings[extensionName].enabled = true;
  saveSettings();

  return true;
}


export function displayExpiryInfo() {
  const now = new Date();
  const daysLeft = Math.ceil(
    (AUTH_CONFIG.expiryDate - now) / (1000* 60 *60* 24),
  );
  const validUntil = localStorage.getItem("plugin_valid_until");

  if (pluginAuthStatus.expired) {
    return '<div class="auth-status expired"><i class="fas fa-exclamation-triangle"></i> 授权已过期</div>';
  } else {
    let validUntilHtml = "";
    if (validUntil) {
      const validUntilDate = new Date(validUntil);
      validUntilHtml = `<small>当前授权有效期至: ${validUntilDate.toLocaleDateString()}</small>`;
    }

    return `
      <div class="auth-status valid">
          <i class="fas fa-lock-open"></i> 授权有效期: ${daysLeft}天
          <small>有效期至: ${AUTH_CONFIG.expiryDate.toLocaleDateString()}</small>
          ${validUntilHtml}
      </div>
    `;
  }
}