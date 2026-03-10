/**
 * 敏感配置字段清单（仅 API Key 类凭证）
 *
 * 只有真正的凭证（API Key）需要保护。
 * API URL 不是凭证——没有 Key 拿到 URL 也无法调用，且 URL 云同步方便多端使用。
 *
 * 这些字段将被 ConfigManager / ApiKeyStore 路由到安全存储，
 * 而不是 extension_settings（后者会被 saveSettingsDebounced 上传到 ST 服务端）。
 */
export const SENSITIVE_KEYS = new Set([
    'apiKey',
    'plotOpt_concurrentApiKey',
    'ngmsApiKey',
    'nccsApiKey',
    'jqyhApiKey',
    'cwb_api_key',
]);
