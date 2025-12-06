import { getContext, extension_settings } from "/scripts/extensions.js";
import { setExtensionPrompt, eventSource, event_types } from "/script.js";
import { callAI } from "./api.js";
import { callNgmsAI } from "./api/Ngms_api.js";
import { extensionName } from "../utils/settings.js";
import { getMemoryState, updateRow, insertRow, deleteRow, clearAllTables } from "./table-system/manager.js";

const FRACTAL_INJECTION_KEY = 'HANLINYUAN_FRACTAL_MEMORY';
const BUFFER_SIZE = 5;
const UPDATE_INTERVAL = 5;



export async function initializeFractalMemory() {
    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
    console.log('[分形记忆] 系统已启动，正在构建多维记忆...');
}

let messageCounter = 0;

async function handleMessageReceived() {
    messageCounter++;
    if (messageCounter >= UPDATE_INTERVAL) {
        messageCounter = 0;
        await updateSceneLayer();
    }
}

async function updateSceneLayer() {
    const context = getContext();
    const settings = extension_settings[extensionName];
    
    if (!settings.fractalMemory) {
        settings.fractalMemory = {
            saga: "故事刚刚开始...",
            arc: [],
            scene: []
        };
    }
    const memory = settings.fractalMemory;

    console.log('[分形记忆] 正在提取近期事态...');

    const recentChat = context.chat.slice(-UPDATE_INTERVAL).map(m => `${m.name}: ${m.mes}`).join('\n');
    
    const prompt = `
请将以下对话总结为一句话的“场景事件”，描述发生了什么。
要求：简洁、客观、包含关键动作。

【对话内容】
${recentChat}

【输出】
(仅输出一句话总结)
`;
    
    const newEvent = await _callLLM(prompt);
    if (!newEvent) return;

    console.log(`[分形记忆] 新增场景事件: ${newEvent}`);
    memory.scene.push(newEvent);

    if (memory.scene.length >= BUFFER_SIZE) {
        await compressSceneToArc();
    }

    context.saveSettingsDebounced();
    injectFractalMemory();
    syncToTables();
}

async function compressSceneToArc() {
    const context = getContext();
    const settings = extension_settings[extensionName];
    const memory = settings.fractalMemory;

    console.log('[分形记忆] 场景层已满，正在压缩至篇章层...');

    const sceneEvents = memory.scene.join('\n');
    const prompt = `
请将以下 5 个连续的“场景事件”合并总结为一条“篇章节点”。
这条节点应该概括这一系列事件对剧情的推动作用。

【场景事件列表】
${sceneEvents}

【输出】
(仅输出一句话总结)
`;

    const newArcEvent = await _callLLM(prompt);
    if (!newArcEvent) return;

    console.log(`[分形记忆] 新增篇章节点: ${newArcEvent}`);
    
    memory.arc.push(newArcEvent);
    memory.scene = [];

    if (memory.arc.length >= BUFFER_SIZE) {
        await compressArcToSaga();
    }
}

async function compressArcToSaga() {
    const context = getContext();
    const settings = extension_settings[extensionName];
    const memory = settings.fractalMemory;

    console.log('[分形记忆] 篇章层已满，正在重写宏观史诗...');

    const arcEvents = memory.arc.join('\n');
    const oldSaga = memory.saga;

    const prompt = `
请根据“旧的宏观史诗”和新发生的“篇章事件”，重写并更新整个故事的“宏观史诗”。
宏观史诗应该是一个高度概括的段落，描述故事的起因、经过和当前状态。

【旧史诗】
${oldSaga}

【新篇章事件】
${arcEvents}

【输出】
(输出一段更新后的宏观史诗，约 100-200 字)
`;

    const newSaga = await _callLLM(prompt);
    if (!newSaga) return;

    console.log(`[分形记忆] 宏观史诗已更新。`);
    
    memory.saga = newSaga;
    memory.arc = [];
}

function syncToTables() {
    const settings = extension_settings[extensionName];
    if (!settings || !settings.fractalMemory) return;
    const memory = settings.fractalMemory;
    const tables = getMemoryState();
    if (!tables) return;

    const targetTableName = '【系统】分形记忆';
    const tableIndex = tables.findIndex(t => t.name === targetTableName);
    
    if (tableIndex !== -1) {
        const table = tables[tableIndex];
        const targetRows = [];

        targetRows.push({
            0: '宏观史诗',
            1: memory.saga
        });

        memory.arc.forEach((event, i) => {
            targetRows.push({
                0: `篇章-${i+1}`,
                1: event
            });
        });

        memory.scene.forEach((event, i) => {
            targetRows.push({
                0: `场景-${i+1}`,
                1: event
            });
        });

        while (table.rows.length > targetRows.length) {
            deleteRow(tableIndex, table.rows.length - 1);
        }

        targetRows.forEach((rowData, i) => {
            if (i < table.rows.length) {
                updateRow(tableIndex, i, rowData);
            } else {
                insertRow(tableIndex, rowData);
            }
        });
    }
}

export function injectFractalMemory() {
    const settings = extension_settings[extensionName];
    if (!settings || !settings.fractalMemory) return;

    const memory = settings.fractalMemory;

    let content = `【分形记忆系统】\n`;
    
    content += `[宏观史诗]\n${memory.saga}\n\n`;
    
    if (memory.arc.length > 0) {
        content += `[当前篇章]\n${memory.arc.map(e => `- ${e}`).join('\n')}\n\n`;
    }
    
    if (memory.scene.length > 0) {
        content += `[近期事态]\n${memory.scene.map(e => `- ${e}`).join('\n')}`;
    }

    setExtensionPrompt(
        FRACTAL_INJECTION_KEY,
        content,
        0, 
        4, 
        false,
        0
    );
}


async function _callLLM(prompt) {
    const settings = extension_settings[extensionName];
    const messages = [{ role: 'user', content: prompt }];
    
    try {
        let responseText = '';
        if (settings.ngmsEnabled) {
            responseText = await callNgmsAI(messages);
        } else {
            responseText = await callAI(messages);
        }
        return responseText.trim();
    } catch (error) {
        console.error('[分形记忆] AI 调用失败:', error);
        return null;
    }
}
