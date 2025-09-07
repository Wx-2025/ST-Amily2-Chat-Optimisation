import { SETTINGS_KEY, defaultPrompts, defaultMixedOrder } from './config.js';

let presetManager = {
    activePreset: '默认预设',
    presets: {
        '默认预设': {
            prompts: JSON.parse(JSON.stringify(defaultPrompts)),
            mixedOrder: JSON.parse(JSON.stringify(defaultMixedOrder))
        }
    }
};

let currentPresets = {};
let currentMixedOrder = {};

export function getPresetManager() {
    return presetManager;
}

export function setPresetManager(newManager) {
    presetManager = newManager;
}

export function getCurrentPresets() {
    return currentPresets;
}

export function setCurrentPresets(newPresets) {
    currentPresets = newPresets;
}

export function getCurrentMixedOrder() {
    return currentMixedOrder;
}

export function setCurrentMixedOrder(newOrder) {
    currentMixedOrder = newOrder;
}

export function loadPresets() {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
        try {
            presetManager = JSON.parse(saved);
            if (!presetManager.presets || !presetManager.activePreset) {
                throw new Error("Invalid preset data structure");
            }
        } catch (e) {
            console.error("Failed to load Amily2 presets, resetting to default.", e);
            toastr.error("加载预设失败，已重置为默认设置。");
            resetToDefaultManager();
        }
    } else {
        migrateFromOldVersion();
    }
    
    loadActivePreset();
}

function migrateFromOldVersion() {
    const oldSettingsKey = 'amily2_prompt_presets_v2';
    const oldSaved = localStorage.getItem(oldSettingsKey);
    const oldSavedMixedOrder = localStorage.getItem(oldSettingsKey + '_mixed_order');

    if (oldSaved) {
        try {
            const oldPrompts = JSON.parse(oldSaved);
            const oldMixedOrder = oldSavedMixedOrder ? JSON.parse(oldSavedMixedOrder) : defaultMixedOrder;
            
            presetManager.presets['默认预设'] = {
                prompts: oldPrompts,
                mixedOrder: oldMixedOrder
            };
            
            toastr.info("旧版本设置已成功迁移！");
            
            localStorage.removeItem(oldSettingsKey);
            localStorage.removeItem(oldSettingsKey + '_mixed_order');
        } catch (e) {
            console.error("Failed to migrate old presets", e);
            resetToDefaultManager();
        }
    } else {
        toastr.success("未检测到 Amily2 预设，已为您初始化默认设置。");
        resetToDefaultManager();
        loadActivePreset();
        savePresets();
    }
}

function resetToDefaultManager() {
    presetManager = {
        activePreset: '默认预设',
        presets: {
            '默认预设': {
                prompts: JSON.parse(JSON.stringify(defaultPrompts)),
                mixedOrder: JSON.parse(JSON.stringify(defaultMixedOrder))
            }
        }
    };
}

export function loadActivePreset() {
    const activePresetName = presetManager.activePreset;
    const activePresetData = presetManager.presets[activePresetName];
    
    if (activePresetData) {
        currentPresets = JSON.parse(JSON.stringify(activePresetData.prompts));
        currentMixedOrder = JSON.parse(JSON.stringify(activePresetData.mixedOrder));
        let isMigrated = false;

        const cwbMigrationChecks = {
            'cwb_summarizer': ['cwb_break_armor_prompt', 'cwb_char_card_prompt', 'newContext'],
            'cwb_summarizer_incremental': ['cwb_break_armor_prompt', 'cwb_char_card_prompt', 'cwb_incremental_char_card_prompt', 'oldFiles', 'newContext']
        };

        for (const sectionKey in cwbMigrationChecks) {
            const requiredBlocks = cwbMigrationChecks[sectionKey];
            const order = currentMixedOrder[sectionKey] || [];
            
            const isMissingBlocks = !requiredBlocks.every(blockId => 
                order.some(item => item.type === 'conditional' && item.id === blockId)
            );

            if (isMissingBlocks) {
                console.log(`Amily2: 检测到 CWB 模块 [${sectionKey}] 缺少必要的条件块，正在执行迁移...`);
                currentPresets[sectionKey] = JSON.parse(JSON.stringify(defaultPrompts[sectionKey]));
                currentMixedOrder[sectionKey] = JSON.parse(JSON.stringify(defaultMixedOrder[sectionKey]));
                isMigrated = true;
            }
        }

        const sectionsToMigrate = ['batch_filler', 'secondary_filler', 'reorganizer'];

        sectionsToMigrate.forEach(sectionKey => {
            if (!currentPresets[sectionKey]) {
                currentPresets[sectionKey] = JSON.parse(JSON.stringify(defaultPrompts[sectionKey]));
                isMigrated = true;
            }
            if (!currentMixedOrder[sectionKey]) {
                currentMixedOrder[sectionKey] = JSON.parse(JSON.stringify(defaultMixedOrder[sectionKey]));
                isMigrated = true;
            }
        });

        if (currentMixedOrder.reorganizer && currentMixedOrder.reorganizer.some(item => item.id === 'thinkingFramework')) {
            console.log("Amily2: 检测到旧版 reorganizer 配置，正在执行一次性迁移...");
            currentPresets.reorganizer = JSON.parse(JSON.stringify(defaultPrompts.reorganizer));
            currentMixedOrder.reorganizer = JSON.parse(JSON.stringify(defaultMixedOrder.reorganizer));
            isMigrated = true;
        }

        sectionsToMigrate.forEach(sectionKey => {
            const order = currentMixedOrder[sectionKey] || [];
            let sectionMigrated = false;
            
            if (!order.some(item => item.type === 'conditional' && item.id === 'worldbook')) {
                const worldBookBlock = { type: 'conditional', id: 'worldbook' };
                let ruleTemplateIndex = order.findIndex(item => item.type === 'conditional' && item.id === 'ruleTemplate');
                if (ruleTemplateIndex !== -1) {
                    order.splice(ruleTemplateIndex, 0, worldBookBlock);
                } else {
                    let lastPromptIndex = -1;
                    order.forEach((item, index) => {
                        if (item.type === 'prompt') {
                            lastPromptIndex = index;
                        }
                    });
                    order.splice(lastPromptIndex + 1, 0, worldBookBlock);
                }
                sectionMigrated = true;
            }
            
            if (sectionKey === 'secondary_filler' && !order.some(item => item.type === 'conditional' && item.id === 'contextHistory')) {
                const contextHistoryBlock = { type: 'conditional', id: 'contextHistory' };
                let worldbookIndex = order.findIndex(item => item.type === 'conditional' && item.id === 'worldbook');
                if (worldbookIndex !== -1) {
                    order.splice(worldbookIndex + 1, 0, contextHistoryBlock);
                } else {
                    let lastPromptIndex = -1;
                    order.forEach((item, index) => {
                        if (item.type === 'prompt') {
                            lastPromptIndex = index;
                        }
                    });
                    order.splice(lastPromptIndex + 1, 0, contextHistoryBlock);
                }
                sectionMigrated = true;
            }
            
            if (sectionMigrated) {
                currentMixedOrder[sectionKey] = order;
                isMigrated = true;
            }
        });

        if (isMigrated) {
            console.log("Amily2: 自动迁移预设，更新到最新版本。");
            presetManager.presets[activePresetName].prompts = JSON.parse(JSON.stringify(currentPresets));
            presetManager.presets[activePresetName].mixedOrder = JSON.parse(JSON.stringify(currentMixedOrder));
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(presetManager));
            toastr.info("Amily2 提示词预设已自动更新以支持最新功能。");
        }

    } else {
        const firstPresetName = Object.keys(presetManager.presets)[0];
        if (firstPresetName) {
            presetManager.activePreset = firstPresetName;
            loadActivePreset();
        } else {
            resetToDefaultManager();
            loadActivePreset();
        }
    }
}

export function savePresets() {
    const activePresetName = presetManager.activePreset;
    if (presetManager.presets[activePresetName]) {
        presetManager.presets[activePresetName].prompts = currentPresets;
        presetManager.presets[activePresetName].mixedOrder = currentMixedOrder;
    }
    
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(presetManager));
    toastr.success(`预设 "${presetManager.activePreset}" 已保存！`);
}

export function getPresetPrompts(sectionKey) {
    const presets = currentPresets[sectionKey];
    const order = currentMixedOrder[sectionKey];
    
    if (!presets || presets.length === 0 || !order) {
        console.warn(`Amily2: getPresetPrompts - 没有找到 ${sectionKey} 的数据`);
        return null;
    }

    const orderedPrompts = [];
    
    console.log(`Amily2: getPresetPrompts - ${sectionKey} 顺序:`, order);
    
    order.forEach((item, index) => {
        if (item.type === 'prompt' && presets[item.index] !== undefined) {
            const prompt = JSON.parse(JSON.stringify(presets[item.index]));
            orderedPrompts.push(prompt);
            console.log(`Amily2: 添加提示词 ${index}:`, { role: prompt.role, content: prompt.content.substring(0, 50) + '...' });
        }
    });
    
    console.log(`Amily2: getPresetPrompts - ${sectionKey} 返回 ${orderedPrompts.length} 个提示词`);
    return orderedPrompts.length > 0 ? orderedPrompts : null;
}

export function getMixedOrder(sectionKey) {
    const order = currentMixedOrder[sectionKey] || null;
    console.log(`Amily2: getMixedOrder - ${sectionKey}:`, order);
    return order;
}

export function createNewPreset() {
    const newName = prompt("请输入新预设的名称：");

    if (newName === null) {
        return false;
    }

    const trimmedNewName = newName.trim();

    if (trimmedNewName === "") {
        toastr.warning("预设名称不能为空！");
        return false;
    }

    if (presetManager.presets[trimmedNewName]) {
        toastr.error("该名称的预设已存在！");
        return false;
    }

    const currentPresetData = presetManager.presets[presetManager.activePreset];
    presetManager.presets[trimmedNewName] = JSON.parse(JSON.stringify(currentPresetData));
    presetManager.activePreset = trimmedNewName;

    savePresets();
    loadActivePreset();
    toastr.success(`新预设 "${trimmedNewName}" 已创建并激活！`);
    return true;
}

export function renamePreset() {
    const oldName = presetManager.activePreset;
    const newName = prompt(`请输入 "${oldName}" 的新名称：`, oldName);

    if (newName === null) {
        return false;
    }

    const trimmedNewName = newName.trim();

    if (trimmedNewName === oldName) {
        return false;
    }

    if (trimmedNewName === "") {
        toastr.warning("预设名称不能为空！");
        return false;
    }

    if (presetManager.presets[trimmedNewName]) {
        toastr.error("该名称的预设已存在！");
        return false;
    }

    presetManager.presets[trimmedNewName] = presetManager.presets[oldName];
    delete presetManager.presets[oldName];
    presetManager.activePreset = trimmedNewName;

    savePresets();
    toastr.success(`预设已重命名为 "${trimmedNewName}"！`);
    return true;
}

export function deletePreset() {
    const nameToDelete = presetManager.activePreset;
    if (Object.keys(presetManager.presets).length <= 1) {
        toastr.error("不能删除唯一的预设！");
        return false;
    }
    
    if (confirm(`您确定要删除预设 "${nameToDelete}" 吗？此操作无法撤销。`)) {
        delete presetManager.presets[nameToDelete];
        
        presetManager.activePreset = Object.keys(presetManager.presets)[0];
        
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(presetManager));
        
        loadActivePreset();
        toastr.success(`预设 "${nameToDelete}" 已删除！`);
        return true;
    }
    return false;
}

export function switchPreset(presetName) {
    if (presetManager.presets[presetName]) {
        presetManager.activePreset = presetName;
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(presetManager));
        loadActivePreset();
        toastr.clear();
        toastr.info(`已切换到预设 "${presetName}"`);
        return true;
    }
    return false;
}

export function resetSectionPreset(sectionKey) {
    currentPresets[sectionKey] = JSON.parse(JSON.stringify(defaultPrompts[sectionKey]));
    currentMixedOrder[sectionKey] = JSON.parse(JSON.stringify(defaultMixedOrder[sectionKey]));
    savePresets();
    toastr.success(`${sectionKey} 已恢复为默认设置！`);
}

export function resetPresets() {
    const activePresetName = presetManager.activePreset;
    presetManager.presets[activePresetName] = {
        prompts: JSON.parse(JSON.stringify(defaultPrompts)),
        mixedOrder: JSON.parse(JSON.stringify(defaultMixedOrder))
    };
    
    loadActivePreset();
    savePresets();
    toastr.success(`预设 "${activePresetName}" 已恢复为默认设置！`);
}
