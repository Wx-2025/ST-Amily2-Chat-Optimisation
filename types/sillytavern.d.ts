// SillyTavern 全局模块的环境声明。
// 让 import { ... } from '/script.js' 这类绝对路径在 TS 引擎眼里能解析。
// 此文件不被运行时加载，仅供 jsconfig.json 的 checkJs 使用。
//
// 字段类型一律 any —— 不做强约束，只为消除 "Cannot find module" 红线。
// 想要真类型，把对应字段改成具体签名即可。

declare module '/script.js' {
    export const saveChat: any;
    export const saveChatDebounced: any;
    export const saveSettingsDebounced: any;
    export const saveSettings: any;
    export const characters: any;
    export const this_chid: any;
    export const eventSource: any;
    export const event_types: any;
    export const getRequestHeaders: any;
    export const name1: any;
    export const name2: any;
    export const chat: any;
    export const reloadCurrentChat: any;
    export const saveChatConditional: any;
    const _default: any;
    export default _default;
}

declare module '/scripts/extensions.js' {
    export const extension_settings: any;
    export const getContext: any;
    export const renderExtensionTemplate: any;
    export const renderExtensionTemplateAsync: any;
    export const writeExtensionField: any;
    const _default: any;
    export default _default;
}

declare module '/scripts/world-info.js' {
    export const loadWorldInfo: any;
    export const saveWorldInfo: any;
    export const world_names: any;
    export const getWorldInfoPrompt: any;
    const _default: any;
    export default _default;
}

declare module '/scripts/slash-commands.js' {
    const anything: any;
    export = anything;
}

declare module '/scripts/extensions/*' {
    const anything: any;
    export = anything;
}

// 全局对象 —— 在 .js 文件里直接用 toastr / window.Amily2Bus 不会被标红。
declare global {
    const toastr: any;
    interface Window {
        Amily2Bus: any;
        AMILY2_SYSTEM_PARALYZED: boolean;
        AMILY2_MACRO_REPLACED: boolean;
        MiZheSi_Global: any;
        _amilySafeConsole: any;
    }
}

export {};
