/**
 * plot-opt-bindings.js — 剧情优化 + JQYH 面板的所有 UI 事件绑定
 *
 * 从 bindings.js 中拆分而来，由 PlotOptModule.mount() 调用入口函数
 * initializePlotOptimizationBindings()。
 */

import { extension_settings, getContext } from "/scripts/extensions.js";
import { characters, this_chid, getRequestHeaders, saveSettingsDebounced, eventSource, event_types } from "/script.js";
import { defaultSettings, extensionName } from "../utils/settings.js";
import { testJqyhApiConnection, fetchJqyhModels } from '../core/api/JqyhApi.js';
import { testConcurrentApiConnection, fetchConcurrentModels } from '../core/api/ConcurrentApi.js';
import { safeLorebooks, safeCharLorebooks, safeLorebookEntries } from "../core/tavernhelper-compatibility.js";
import { createDrawer } from '../ui/drawer.js';
import { pluginAuthStatus } from "../utils/auth.js";
import { configManager } from '../utils/config/ConfigManager.js';
import { SENSITIVE_KEYS } from '../utils/config/sensitive-keys.js';

// ========== Prompt Cache (module-level state) ==========

const promptCache = {
    main: '',
    system: '',
    final_system: ''
};

// ========== 导出函数 ==========

export function opt_saveAllSettings() {
    const panel = $('#amily2_plot_optimization_panel');
    if (panel.length === 0) return;

    console.log(`[${extensionName}] 手动触发所有剧情优化设置的保存...`);
    panel.find('input[type="checkbox"], input[type="radio"], input[type="text"], input[type="password"], textarea, select').trigger('change.amily2_opt');

    panel.find('input[type="range"]').trigger('change.amily2_opt');

    opt_saveEnabledEntries();

    toastr.info('剧情优化设置已自动保存。');
}


function opt_toCamelCase(str) {
    return str.replace(/[-_]([a-z])/g, (g) => g[1].toUpperCase());
}

function opt_updateApiUrlVisibility(panel, apiMode) {
    const customApiSettings = panel.find('#amily2_opt_custom_api_settings_block');
    const tavernProfileSettings = panel.find('#amily2_opt_tavern_api_profile_block');
    const apiUrlInput = panel.find('#amily2_opt_api_url');

    customApiSettings.hide();
    tavernProfileSettings.hide();

    if (apiMode === 'tavern') {
        tavernProfileSettings.show();
    } else {
        customApiSettings.show();
        if (apiMode === 'google') {
            panel.find('#amily2_opt_api_url_block').hide();
            const googleUrl = 'https://generativelanguage.googleapis.com';
            if (apiUrlInput.val() !== googleUrl) {
                apiUrlInput.val(googleUrl).attr('type', 'text').trigger('change');
            }
        } else {
            panel.find('#amily2_opt_api_url_block').show();
        }
    }
}

function opt_updateWorldbookSourceVisibility(panel, source) {
    const manualSelectionWrapper = panel.find('#amily2_opt_worldbook_select_wrapper');
    if (source === 'manual') {
        manualSelectionWrapper.show();
        const selectBox = manualSelectionWrapper.find('#amily2_opt_selected_worldbooks');
        selectBox.css({
            'height': 'auto',
            'background-color': 'var(--bg1)',
            'appearance': 'none',
            '-webkit-appearance': 'none'
        });
    } else {
        manualSelectionWrapper.hide();
    }
}

async function opt_loadTavernApiProfiles(panel) {
    const select = panel.find('#amily2_opt_tavern_api_profile_select');
    const apiSettings = opt_getMergedSettings();
    const currentProfileId = apiSettings.plotOpt_tavernProfile;

    const currentValue = select.val();
    select.empty().append(new Option('-- 请选择一个酒馆预设 --', ''));

    try {
        const tavernProfiles = getContext().extensionSettings?.connectionManager?.profiles || [];
        if (!tavernProfiles || tavernProfiles.length === 0) {
            select.append($('<option>', { value: '', text: '未找到酒馆预设', disabled: true }));
            return;
        }

        let foundCurrentProfile = false;
        tavernProfiles.forEach(profile => {
            if (profile.api && profile.preset) {
                const option = $('<option>', {
                    value: profile.id,
                    text: profile.name || profile.id,
                    selected: profile.id === currentProfileId
                });
                select.append(option);
                if (profile.id === currentProfileId) {
                    foundCurrentProfile = true;
                }
            }
        });

        if (currentProfileId && !foundCurrentProfile) {
            toastr.warning(`之前选择的酒馆预设 "${currentProfileId}" 已不存在，请重新选择。`);
            opt_saveSetting('tavernProfile', '');
        } else if (foundCurrentProfile) {
             select.val(currentProfileId);
        }

    } catch (error) {
        console.error(`[${extensionName}] 加载酒馆API预设失败:`, error);
        toastr.error('无法加载酒馆API预设列表，请查看控制台。');
    }
}


const opt_characterSpecificSettings = [
    'plotOpt_worldbookSource',
    'plotOpt_selectedWorldbooks',
    'plotOpt_autoSelectWorldbooks',
    'plotOpt_enabledWorldbookEntries'
];


async function opt_saveSetting(key, value) {
    if (opt_characterSpecificSettings.includes(key)) {
        const character = characters[this_chid];
        if (!character) return;

        if (!character.data.extensions) character.data.extensions = {};
        if (!character.data.extensions[extensionName]) character.data.extensions[extensionName] = {};

        character.data.extensions[extensionName][key] = value;

        try {
            const response = await fetch('/api/characters/merge-attributes', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    avatar: character.avatar,
                    data: { extensions: { [extensionName]: character.data.extensions[extensionName] } }
                })
            });

            if (!response.ok) throw new Error(`API call failed with status: ${response.status}`);
            console.log(`[${extensionName}] 角色卡设置已更新: ${key} ->`, value);
        } catch (error) {
            console.error(`[${extensionName}] 保存角色数据失败:`, error);
            toastr.error('无法保存角色卡设置，请检查控制台。');
        }
    } else if (SENSITIVE_KEYS.has(key)) {
        // 敏感字段（API Key）经 configManager 写入 localStorage
        configManager.set(key, value);
    } else {
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {};
        }
        extension_settings[extensionName][key] = value;
        saveSettingsDebounced();
    }
}


function opt_getMergedSettings() {
    const character = characters[this_chid];
    const globalSettings = extension_settings[extensionName] || defaultSettings;
    const characterSettings = character?.data?.extensions?.[extensionName] || {};

    return { ...globalSettings, ...characterSettings };
}



function opt_bindSlider(panel, sliderId, displayId) {
    const slider = panel.find(sliderId);
    const display = panel.find(displayId);

    display.text(slider.val());

    slider.on('input', function() {
        display.text($(this).val());
    });
}

async function opt_loadWorldbooks(panel) {
    const container = panel.find('#amily2_opt_worldbook_checkbox_list');
    const settings = opt_getMergedSettings();
    const currentSelection = settings.plotOpt_selectedWorldbooks || [];
    container.empty();

    // 移除旧的搜索框以防重复
    panel.find('#amily2_opt_worldbook_search').remove();
    const searchBox = $(`<input type="text" id="amily2_opt_worldbook_search" class="text_pole" placeholder="搜索世界书..." style="width: 100%; margin-bottom: 10px;">`);
    container.before(searchBox);

    searchBox.on('input', function() {
        const searchTerm = $(this).val().toLowerCase();
        container.find('.amily2_opt_worldbook_list_item').each(function() {
            const bookName = $(this).find('label').text().toLowerCase();
            if (bookName.includes(searchTerm)) {
                $(this).show();
            } else {
                $(this).hide();
            }
        });
    });

    try {
        const lorebooks = await safeLorebooks();
        if (!lorebooks || lorebooks.length === 0) {
            container.html('<p class="notes">未找到世界书。</p>');
            return;
        }

        lorebooks.forEach(name => {
            const bookId = `amily2-opt-wb-check-${name.replace(/[^a-zA-Z0-9]/g, '-')}`;
            const isChecked = currentSelection.includes(name);

            // Auto Select Logic
            const autoId = `amily2-opt-wb-auto-${name.replace(/[^a-zA-Z0-9]/g, '-')}`;
            const isAuto = (settings.plotOpt_autoSelectWorldbooks || []).includes(name);

            const item = $(`
                <div class="amily2_opt_worldbook_list_item" style="display: flex; align-items: center; justify-content: space-between; padding-right: 5px;">
                    <div style="display: flex; align-items: center;">
                        <input type="checkbox" id="${bookId}" value="${name}" ${isChecked ? 'checked' : ''} style="margin-right: 5px;">
                        <label for="${bookId}" style="margin-bottom: 0;">${name}</label>
                    </div>
                     <div style="display: flex; align-items: center;" title="开启后自动加载该世界书所有条目（包括新增）">
                        <input type="checkbox" class="amily2_opt_wb_auto_check" id="${autoId}" data-book="${name}" ${isAuto ? 'checked' : ''} style="margin-right: 5px;">
                        <label for="${autoId}" style="margin-bottom: 0; font-size: 0.9em; opacity: 0.8; cursor: pointer;">全选</label>
                    </div>
                </div>
            `);
            container.append(item);
        });
    } catch (error) {
        console.error(`[${extensionName}] 加载世界书失败:`, error);
        container.html('<p class="notes" style="color:red;">加载世界书列表失败。</p>');
        toastr.error('无法加载世界书列表，请查看控制台。');
    }
}

async function opt_loadWorldbookEntries(panel) {
    const container = panel.find('#amily2_opt_worldbook_entry_list_container');
    const countDisplay = panel.find('#amily2_opt_worldbook_entry_count');
    container.html('<p>加载条目中...</p>');
    countDisplay.text('');

    // 移除旧的搜索框以防重复
    panel.find('#amily2_opt_worldbook_entry_search').remove();
    const searchBox = $(`<input type="text" id="amily2_opt_worldbook_entry_search" class="text_pole" placeholder="搜索条目..." style="width: 100%; margin-bottom: 10px;">`);
    container.before(searchBox);

    searchBox.on('input', function() {
        const searchTerm = $(this).val().toLowerCase();
        let visibleCount = 0;
        container.find('.amily2_opt_worldbook_entry_item').each(function() {
            const entryName = $(this).find('label').text().toLowerCase();
            if (entryName.includes(searchTerm)) {
                $(this).show();
                visibleCount++;
            } else {
                $(this).hide();
            }
        });
        const totalEntries = container.find('.amily2_opt_worldbook_entry_item').length;
        countDisplay.text(`显示 ${visibleCount} / ${totalEntries} 条目.`);
    });

    const settings = opt_getMergedSettings();
    const currentSource = settings.plotOpt_worldbookSource || 'character';
    let bookNames = [];

    if (currentSource === 'manual') {
        bookNames = settings.plotOpt_selectedWorldbooks || [];
    } else {

        if (this_chid === -1 || !characters[this_chid]) {
            container.html('<p class="notes">未选择角色。</p>');
            countDisplay.text('');
            return;
        }
        try {
            const charLorebooks = await safeCharLorebooks({ type: 'all' });
            if (charLorebooks.primary) bookNames.push(charLorebooks.primary);
            if (charLorebooks.additional?.length) bookNames.push(...charLorebooks.additional);
        } catch (error) {

            console.error(`[${extensionName}] 获取角色世界书失败:`, error);
            toastr.error('获取角色世界书失败。');
            container.html('<p class="notes" style="color:red;">获取角色世界书失败。</p>');
            return;
        }
    }

    const selectedBooks = bookNames;
    let enabledEntries = settings.plotOpt_enabledWorldbookEntries || {};
    let totalEntries = 0;
    let visibleEntries = 0;

    if (selectedBooks.length === 0) {
        container.html('<p class="notes">请选择一个或多个世界书以查看其条目。</p>');
        return;
    }

    try {
        const allEntries = [];
        for (const bookName of selectedBooks) {
            const entries = await safeLorebookEntries(bookName);
            entries.forEach(entry => {
                allEntries.push({ ...entry, bookName });
            });
        }

        // 根据用户要求，只显示默认启用的条目
        const enabledOnlyEntries = allEntries.filter(entry => entry.enabled);

        container.empty();

        totalEntries = enabledOnlyEntries.length;

        if (totalEntries === 0) {
            container.html('<p class="notes">所选世界书没有（已启用的）条目。</p>');
            countDisplay.text('0 条目.');
            return;
        }

        enabledOnlyEntries.sort((a, b) => (a.comment || '').localeCompare(b.comment || '')).forEach(entry => {
            const entryId = `amily2-opt-entry-${entry.bookName.replace(/[^a-zA-Z0-9]/g, '-')}-${entry.uid}`;

            const isAuto = (settings.plotOpt_autoSelectWorldbooks || []).includes(entry.bookName);
            // If auto is enabled, the entry is forced enabled in logic, so show checked and disabled
            const isChecked = isAuto || (enabledEntries[entry.bookName]?.includes(entry.uid) ?? true);
            const isDisabled = isAuto;

            const item = $(`
                <div class="amily2_opt_worldbook_entry_item" style="display: flex; align-items: center;">
                    <input type="checkbox" id="${entryId}" data-book="${entry.bookName}" data-uid="${entry.uid}" ${isChecked ? 'checked' : ''} ${isDisabled ? 'disabled' : ''} style="margin-right: 5px;">
                    <label for="${entryId}" title="世界书: ${entry.bookName}\nUID: ${entry.uid}" style="margin-bottom: 0; ${isDisabled ? 'opacity:0.7;' : ''}">${entry.comment || '无标题条目'} ${isAuto ? '<span style="font-size:0.8em; opacity:0.6;">(全选生效中)</span>' : ''}</label>
                </div>
            `);
            container.append(item);
        });

        visibleEntries = container.children().length;
        countDisplay.text(`显示 ${visibleEntries} / ${totalEntries} 条目.`);

    } catch (error) {
        console.error(`[${extensionName}] 加载世界书条目失败:`, error);
        container.html('<p class="notes" style="color:red;">加载条目失败。</p>');
    }
}


function opt_saveEnabledEntries() {
    const panel = $('#amily2_plot_optimization_panel');
    let enabledEntries = {};

    panel.find('#amily2_opt_worldbook_entry_list_container input[type="checkbox"]').each(function() {
        const bookName = $(this).data('book');
        const uid = parseInt($(this).data('uid'));

        if (!enabledEntries[bookName]) {
            enabledEntries[bookName] = [];
        }

        if ($(this).is(':checked')) {
            enabledEntries[bookName].push(uid);
        }
    });

    const settings = opt_getMergedSettings();

    if (settings.plotOpt_worldbookSource === 'manual') {
        const selectedBooks = settings.plotOpt_selectedWorldbooks || [];
        Object.keys(enabledEntries).forEach(bookName => {
            if (!selectedBooks.includes(bookName)) {
                delete enabledEntries[bookName];
            }
        });
    }

    opt_saveSetting('plotOpt_enabledWorldbookEntries', enabledEntries);
}


function opt_loadPromptPresets(panel) {
    const presets = extension_settings[extensionName]?.promptPresets || [];
    const select = panel.find('#amily2_opt_prompt_preset_select');
    const settings = opt_getMergedSettings();
    const lastUsedPresetName = settings.plotOpt_lastUsedPresetName;

    select.empty().append(new Option('-- 选择一个预设 --', ''));

    presets.forEach(preset => {
        const option = new Option(preset.name, preset.name);
        if (preset.name === lastUsedPresetName) {
            option.selected = true;
        }
        select.append(option);
    });
}


function opt_saveCurrentPromptsAsPreset(panel) {
    const selectedPresetName = panel.find('#amily2_opt_prompt_preset_select').val();
    let presetName;
    let isOverwriting = false;

    if (selectedPresetName) {
        if (confirm(`您确定要用当前编辑的提示词覆盖预设 "${selectedPresetName}" 吗？`)) {
            presetName = selectedPresetName;
            isOverwriting = true;
        } else {
            toastr.info('保存操作已取消。');
            return;
        }
    } else {
        presetName = prompt("您正在创建一个新的预设，请输入预设名称：");
        if (!presetName) {
            toastr.info('保存操作已取消。');
            return;
        }
    }

    const presets = extension_settings[extensionName]?.promptPresets || [];
    const existingPresetIndex = presets.findIndex(p => p.name === presetName);

    // Ensure the cache is up-to-date before saving
    const currentEditorPromptKey = panel.find('#amily2_opt_prompt_selector').val();
    promptCache[currentEditorPromptKey] = panel.find('#amily2_opt_prompt_editor').val();

    const currentSettings = extension_settings[extensionName] || {};
    const newPresetData = {
        name: presetName,
        mainPrompt: promptCache.main,
        systemPrompt: promptCache.system,
        finalSystemDirective: promptCache.final_system,
        concurrentMainPrompt: currentSettings.plotOpt_concurrentMainPrompt || '',
        concurrentSystemPrompt: currentSettings.plotOpt_concurrentSystemPrompt || '',
        rateMain: parseFloat(panel.find('#amily2_opt_rate_main').val()),
        ratePersonal: parseFloat(panel.find('#amily2_opt_rate_personal').val()),
        rateErotic: parseFloat(panel.find('#amily2_opt_rate_erotic').val()),
        rateCuckold: parseFloat(panel.find('#amily2_opt_rate_cuckold').val())
    };

    if (existingPresetIndex !== -1) {
        presets[existingPresetIndex] = newPresetData;
        toastr.success(`预设 "${presetName}" 已成功覆盖。`);
    } else {
        presets.push(newPresetData);
        toastr.success(`新预设 "${presetName}" 已成功创建。`);
    }
    opt_saveSetting('promptPresets', presets);

    opt_loadPromptPresets(panel);
    setTimeout(() => {
        panel.find('#amily2_opt_prompt_preset_select').val(presetName).trigger('change', { isAutomatic: false });
    }, 0);
}

function opt_deleteSelectedPreset(panel) {
    const select = panel.find('#amily2_opt_prompt_preset_select');
    const selectedName = select.val();

    if (!selectedName) {
        toastr.warning('没有选择任何预设。');
        return;
    }

    if (!confirm(`确定要删除预设 "${selectedName}" 吗？`)) {
        return;
    }

    const presets = extension_settings[extensionName]?.promptPresets || [];
    const indexToDelete = presets.findIndex(p => p.name === selectedName);

    if (indexToDelete > -1) {
        presets.splice(indexToDelete, 1);
        opt_saveSetting('promptPresets', presets);
        toastr.success(`预设 "${selectedName}" 已被删除。`);
    } else {
        toastr.error('找不到要删除的预设，操作可能已过期。');
    }

    opt_loadPromptPresets(panel);
    select.trigger('change');
}

function opt_exportPromptPresets() {
    const select = $('#amily2_opt_prompt_preset_select');
    const selectedName = select.val();

    if (!selectedName) {
        toastr.info('请先从下拉菜单中选择一个要导出的预设。');
        return;
    }

    const presets = extension_settings[extensionName]?.promptPresets || [];
    const selectedPreset = presets.find(p => p.name === selectedName);

    if (!selectedPreset) {
        toastr.error('找不到选中的预设，请刷新页面后重试。');
        return;
    }

    const dataToExport = [selectedPreset];
    const dataStr = JSON.stringify(dataToExport, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `amily2_opt_preset_${selectedName.replace(/[^a-z0-9]/gi, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toastr.success(`预设 "${selectedName}" 已成功导出。`);
}


function opt_importPromptPresets(file, panel) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedPresets = JSON.parse(e.target.result);

            if (!Array.isArray(importedPresets)) {
                throw new Error('JSON文件格式不正确，根节点必须是一个数组。');
            }

            let currentPresets = extension_settings[extensionName]?.promptPresets || [];
            let importedCount = 0;
            let overwrittenCount = 0;

            importedPresets.forEach(preset => {
                if (preset && typeof preset.name === 'string' && preset.name.length > 0) {
                    const presetData = {
                        name: preset.name,
                        mainPrompt: preset.mainPrompt || '',
                        systemPrompt: preset.systemPrompt || '',
                        finalSystemDirective: preset.finalSystemDirective || '',
                        concurrentMainPrompt: preset.concurrentMainPrompt || '',
                        concurrentSystemPrompt: preset.concurrentSystemPrompt || '',
                        rateMain: preset.rateMain ?? 1.0,
                        ratePersonal: preset.ratePersonal ?? 1.0,
                        rateErotic: preset.rateErotic ?? 1.0,
                        rateCuckold: preset.rateCuckold ?? 1.0
                    };

                    const existingIndex = currentPresets.findIndex(p => p.name === preset.name);

                    if (existingIndex !== -1) {
                        currentPresets[existingIndex] = presetData;
                        overwrittenCount++;
                    } else {
                        currentPresets.push(presetData);
                        importedCount++;
                    }
                }
            });

            if (importedCount > 0 || overwrittenCount > 0) {
                const selectedPresetBeforeImport = panel.find('#amily2_opt_prompt_preset_select').val();

                opt_saveSetting('promptPresets', currentPresets);
                opt_loadPromptPresets(panel);
                panel.find('#amily2_opt_prompt_preset_select').val(selectedPresetBeforeImport);
                panel.find('#amily2_opt_prompt_preset_select').trigger('change');

                let messages = [];
                if (importedCount > 0) messages.push(`成功导入 ${importedCount} 个新预设。`);
                if (overwrittenCount > 0) messages.push(`成功覆盖 ${overwrittenCount} 个同名预设。`);
                toastr.success(messages.join(' '));
            } else {
                toastr.warning('未找到可导入的有效预设。');
            }

        } catch (error) {
            console.error(`[${extensionName}] 导入预设失败:`, error);
            toastr.error(`导入失败: ${error.message}`, '错误');
        } finally {
            panel.find('#amily2_opt_preset_file_input').val('');
        }
    };
    reader.readAsText(file);
}

function opt_loadSettings(panel) {
    const settings = opt_getMergedSettings();

    panel.find('#amily2_opt_enabled').prop('checked', settings.plotOpt_enabled);

    // Handle table enabled setting which can be boolean (legacy) or string
    let tableEnabledValue = settings.plotOpt_tableEnabled;
    if (tableEnabledValue === true) {
        tableEnabledValue = 'main';
    } else if (tableEnabledValue === false || tableEnabledValue === undefined) {
        tableEnabledValue = 'disabled';
    }
    panel.find('#amily2_opt_table_enabled').val(tableEnabledValue);

    panel.find('#amily2_opt_ejs_enabled').prop('checked', settings.plotOpt_ejsEnabled);
    panel.find(`input[name="amily2_opt_api_mode"][value="${settings.plotOpt_apiMode}"]`).prop('checked', true);
    panel.find('#amily2_opt_tavern_api_profile_select').val(settings.plotOpt_tavernProfile);
    panel.find(`input[name="amily2_opt_worldbook_source"][value="${settings.plotOpt_worldbookSource || 'character'}"]`).prop('checked', true);
    panel.find('#amily2_opt_worldbook_enabled').prop('checked', settings.plotOpt_worldbookEnabled);
    panel.find('#amily2_opt_new_memory_logic_enabled').prop('checked', settings.plotOpt_newMemoryLogicEnabled);
    panel.find('#amily2_opt_api_url').val(settings.plotOpt_apiUrl);
    // plotOpt_apiKey 是敏感字段，从 configManager（localStorage）读取
    panel.find('#amily2_opt_api_key').val(configManager.get('plotOpt_apiKey') || '');

    const modelInput = panel.find('#amily2_opt_model');
    const modelSelect = panel.find('#amily2_opt_model_select');

    modelInput.val(settings.plotOpt_model);
    modelSelect.empty();
    if (settings.plotOpt_model) {
        modelSelect.append(new Option(settings.plotOpt_model, settings.plotOpt_model, true, true));
    } else {
        modelSelect.append(new Option('<-请先获取模型', '', true, true));
    }

    panel.find('#amily2_opt_max_tokens').val(settings.plotOpt_max_tokens);
    panel.find('#amily2_opt_temperature').val(settings.plotOpt_temperature);
    panel.find('#amily2_opt_top_p').val(settings.plotOpt_top_p);
    panel.find('#amily2_opt_presence_penalty').val(settings.plotOpt_presence_penalty);
    panel.find('#amily2_opt_frequency_penalty').val(settings.plotOpt_frequency_penalty);
    panel.find('#amily2_opt_context_turn_count').val(settings.plotOpt_contextTurnCount);
    panel.find('#amily2_opt_worldbook_char_limit').val(settings.plotOpt_worldbookCharLimit);
    panel.find('#amily2_opt_context_limit').val(settings.plotOpt_contextLimit);

    panel.find('#amily2_opt_rate_main').val(settings.plotOpt_rateMain);
    panel.find('#amily2_opt_rate_personal').val(settings.plotOpt_ratePersonal);
    panel.find('#amily2_opt_rate_erotic').val(settings.plotOpt_rateErotic);
    panel.find('#amily2_opt_rate_cuckold').val(settings.plotOpt_rateCuckold);

    opt_loadPromptPresets(panel);

    const lastUsedPresetName = settings.plotOpt_lastUsedPresetName;

    const initFunc = panel.data('initAmily2PromptEditor');
    if (initFunc) {
        initFunc();
    }

    // After loading presets and initializing the editor, trigger a "light" change event
    // to update UI elements like the delete button, without reloading all the data.
    if (lastUsedPresetName && panel.find('#amily2_opt_prompt_preset_select').val() === lastUsedPresetName) {
        setTimeout(() => {
            panel.find('#amily2_opt_prompt_preset_select').trigger('change', { isAutomatic: true, noLoad: true });
        }, 0);
    }

    opt_updateApiUrlVisibility(panel, settings.plotOpt_apiMode);
    opt_updateWorldbookSourceVisibility(panel, settings.plotOpt_worldbookSource || 'character');

    opt_bindSlider(panel, '#amily2_opt_max_tokens', '#amily2_opt_max_tokens_value');
    opt_bindSlider(panel, '#amily2_opt_temperature', '#amily2_opt_temperature_value');
    opt_bindSlider(panel, '#amily2_opt_top_p', '#amily2_opt_top_p_value');
    opt_bindSlider(panel, '#amily2_opt_presence_penalty', '#amily2_opt_presence_penalty_value');
    opt_bindSlider(panel, '#amily2_opt_frequency_penalty', '#amily2_opt_frequency_penalty_value');
    opt_bindSlider(panel, '#amily2_opt_context_turn_count', '#amily2_opt_context_turn_count_value');
    opt_bindSlider(panel, '#amily2_opt_worldbook_char_limit', '#amily2_opt_worldbook_char_limit_value');
    opt_bindSlider(panel, '#amily2_opt_context_limit', '#amily2_opt_context_limit_value');

    opt_loadWorldbooks(panel).then(() => {
        opt_loadWorldbookEntries(panel);
    });

    opt_loadTavernApiProfiles(panel);
}


function bindConcurrentApiEvents() {
    const concurrentToggle = document.getElementById('amily2_plotOpt_concurrentEnabled');
    const concurrentContent = document.getElementById('amily2_concurrent_content');

    if (!concurrentToggle || !concurrentContent) return;

    const settings = extension_settings[extensionName] || {};

    // Initial Load
    concurrentToggle.checked = settings.plotOpt_concurrentEnabled ?? false;
    concurrentContent.style.display = concurrentToggle.checked ? 'grid' : 'none';

    const fields = [
        { id: 'amily2_plotOpt_concurrentApiProvider', key: 'plotOpt_concurrentApiProvider' },
        { id: 'amily2_plotOpt_concurrentApiUrl', key: 'plotOpt_concurrentApiUrl' },
        { id: 'amily2_plotOpt_concurrentApiKey', key: 'plotOpt_concurrentApiKey', sensitive: true },
        { id: 'amily2_plotOpt_concurrentModel', key: 'plotOpt_concurrentModel' }
    ];

    fields.forEach(field => {
        const element = document.getElementById(field.id);
        if (element) {
            // 敏感字段（API Key）从 configManager（localStorage）读取
            element.value = field.sensitive
                ? (configManager.get(field.key) || '')
                : (settings[field.key] || '');
        }
    });

    // Button Listeners
    const testButton = document.getElementById('amily2_plotOpt_concurrent_test_connection');
    if (testButton) {
        testButton.addEventListener('click', async () => {
            const button = $(testButton);
            const originalHtml = button.html();
            button.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 测试中');
            try {
                await testConcurrentApiConnection();
            } finally {
                button.prop('disabled', false).html(originalHtml);
            }
        });
    }

    const fetchButton = document.getElementById('amily2_plotOpt_concurrent_fetch_models');
    const modelInput = document.getElementById('amily2_plotOpt_concurrentModel');
    const modelSelect = document.getElementById('amily2_plotOpt_concurrentModel_select');

    if (fetchButton && modelInput && modelSelect) {
        fetchButton.addEventListener('click', async () => {
            const button = $(fetchButton);
            const originalHtml = button.html();
            button.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 获取中');
            try {
                const models = await fetchConcurrentModels();
                if (models && models.length > 0) {
                    modelSelect.innerHTML = '<option value="">-- 选择一个模型 --</option>';
                    models.forEach(model => {
                        const option = document.createElement('option');
                        option.value = model.id;
                        option.textContent = model.name;
                        if (model.id === modelInput.value) {
                            option.selected = true;
                        }
                        modelSelect.appendChild(option);
                    });
                    modelSelect.style.display = 'block';
                    modelInput.style.display = 'none';
                    toastr.success(`成功获取 ${models.length} 个并发模型`, '获取模型成功');
                } else {
                    toastr.warning('未获取到任何并发模型。', '获取模型');
                }
            } catch (error) {
                toastr.error(`获取并发模型失败: ${error.message}`, '获取模型失败');
            } finally {
                button.prop('disabled', false).html(originalHtml);
            }
        });

        modelSelect.addEventListener('change', function() {
            const selectedModel = this.value;
            if (selectedModel) {
                modelInput.value = selectedModel;
                 if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
                extension_settings[extensionName].plotOpt_concurrentModel = selectedModel;
                saveSettingsDebounced();
            }
        });
    }


    // Event Listeners
    concurrentToggle.addEventListener('change', function() {
        const isEnabled = this.checked;
        if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
        extension_settings[extensionName].plotOpt_concurrentEnabled = isEnabled;
        saveSettingsDebounced();
        concurrentContent.style.display = isEnabled ? 'grid' : 'none';
    });

    fields.forEach(field => {
        const element = document.getElementById(field.id);
        if (element) {
            element.addEventListener('change', function() {
                if (field.sensitive) {
                    configManager.set(field.key, this.value);
                } else {
                    if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
                    extension_settings[extensionName][field.key] = this.value;
                    saveSettingsDebounced();
                }
            });
        }
    });

    // Slider Bindings
    const sliderFields = [
        { id: 'amily2_plotOpt_concurrentMaxTokens', key: 'plotOpt_concurrentMaxTokens', defaultValue: 8100 }
    ];

    sliderFields.forEach(field => {
        const slider = document.getElementById(field.id);
        const display = document.getElementById(field.id + '_value');
        if (slider && display) {
            const value = settings[field.key] || field.defaultValue;
            slider.value = value;
            display.textContent = value;

            slider.addEventListener('input', function() {
                const newValue = parseInt(this.value, 10);
                display.textContent = newValue;
                if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
                extension_settings[extensionName][field.key] = newValue;
                saveSettingsDebounced();
            });
        }
    });
}

function bindConcurrentPromptEvents() {
    const panel = $('#sinan-prompt-settings-tab');
    if (panel.length === 0) return;

    const selector = panel.find('#amily2_concurrent_prompt_selector');
    const editor = panel.find('#amily2_concurrent_prompt_editor');
    const resetButton = panel.find('#amily2_opt_reset_concurrent_prompt');

    const promptMap = {
        main: 'plotOpt_concurrentMainPrompt',
        system: 'plotOpt_concurrentSystemPrompt'
    };

    function updateConcurrentEditor() {
        const settings = extension_settings[extensionName] || {};
        const selectedKey = selector.val();
        const settingKey = promptMap[selectedKey];
        editor.val(settings[settingKey] || '');
    }

    // Initial load
    updateConcurrentEditor();

    // Event Listeners
    selector.on('change', updateConcurrentEditor);

    editor.on('input', function() {
        const selectedKey = selector.val();
        const settingKey = promptMap[selectedKey];
        if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
        extension_settings[extensionName][settingKey] = $(this).val();
        saveSettingsDebounced();
    });

    resetButton.on('click', function() {
        const selectedKey = selector.val();
        const settingKey = promptMap[selectedKey];
        const defaultValue = defaultSettings[settingKey] || '';

        if (confirm(`您确定要将 "${selector.find('option:selected').text()}" 恢复为默认值吗？`)) {
            editor.val(defaultValue);
            if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
            extension_settings[extensionName][settingKey] = defaultValue;
            saveSettingsDebounced();
            toastr.success('并发提示词已成功恢复为默认值。');
        }
    });
}

function opt_loadConcurrentWorldbookSettings() {
    const panel = $('#amily2_plot_optimization_panel');
    if (panel.length === 0) return;

    const settings = extension_settings[extensionName] || {};
    const enabledCheckbox = panel.find('#amily2_plotOpt_concurrentWorldbookEnabled');
    const sourceRadios = panel.find('input[name="amily2_plotOpt_concurrentWorldbook_source"]');
    const charLimitSlider = panel.find('#amily2_plotOpt_concurrentWorldbookCharLimit');
    const charLimitValue = panel.find('#amily2_plotOpt_concurrentWorldbookCharLimit_value');

    enabledCheckbox.prop('checked', settings.plotOpt_concurrentWorldbookEnabled ?? true);
    const currentSource = settings.plotOpt_concurrentWorldbookSource || 'character';
    panel.find(`input[name="amily2_plotOpt_concurrentWorldbook_source"][value="${currentSource}"]`).prop('checked', true);
    charLimitSlider.val(settings.plotOpt_concurrentWorldbookCharLimit || 60000);
    charLimitValue.text(charLimitSlider.val());

    // This will also trigger the visibility update
    enabledCheckbox.trigger('change');
}

function bindConcurrentWorldbookEvents() {
    const panel = $('#amily2_plot_optimization_panel');
    if (panel.length === 0) return;

    const settings = extension_settings[extensionName] || {};
    const enabledCheckbox = panel.find('#amily2_plotOpt_concurrentWorldbookEnabled');
    const contentDiv = panel.find('#amily2_concurrent_worldbook_content');
    const sourceRadios = panel.find('input[name="amily2_plotOpt_concurrentWorldbook_source"]');
    const manualSelectWrapper = panel.find('#amily2_plotOpt_concurrent_worldbook_select_wrapper');
    const refreshButton = panel.find('#amily2_plotOpt_concurrent_refresh_worldbooks');
    const bookListContainer = panel.find('#amily2_plotOpt_concurrent_worldbook_checkbox_list');
    const charLimitSlider = panel.find('#amily2_plotOpt_concurrentWorldbookCharLimit');
    const charLimitValue = panel.find('#amily2_plotOpt_concurrentWorldbookCharLimit_value');

    function updateVisibility() {
        const isEnabled = enabledCheckbox.is(':checked');
        contentDiv.css('display', isEnabled ? 'block' : 'none');
        if (isEnabled) {
            const source = panel.find('input[name="amily2_plotOpt_concurrentWorldbook_source"]:checked').val();
            manualSelectWrapper.css('display', source === 'manual' ? 'block' : 'none');
        }
    }

    async function loadConcurrentWorldbooks() {
        bookListContainer.html('<p class="notes">加载中...</p>');
        try {
            const lorebooks = await safeLorebooks();
            bookListContainer.empty();
            if (!lorebooks || lorebooks.length === 0) {
                bookListContainer.html('<p class="notes">未找到世界书。</p>');
                return;
            }
            const selectedBooks = settings.plotOpt_concurrentSelectedWorldbooks || [];
            const autoSelectedBooks = settings.plotOpt_concurrentAutoSelectWorldbooks || [];
            lorebooks.forEach(name => {
                const bookId = `amily2-opt-concurrent-wb-check-${name.replace(/[^a-zA-Z0-9]/g, '-')}`;
                const autoId = `amily2-opt-concurrent-wb-auto-${name.replace(/[^a-zA-Z0-9]/g, '-')}`;
                const isChecked = selectedBooks.includes(name);
                const isAuto = autoSelectedBooks.includes(name);
                const item = $(`
                    <div class="amily2_opt_worldbook_list_item" style="display: flex; align-items: center; justify-content: space-between; padding-right: 5px;">
                        <div style="display: flex; align-items: center;">
                            <input type="checkbox" id="${bookId}" value="${name}" ${isChecked ? 'checked' : ''} style="margin-right: 5px;">
                            <label for="${bookId}" style="margin-bottom: 0;">${name}</label>
                        </div>
                        <div style="display: flex; align-items: center;" title="开启后自动加载该世界书所有条目（包括新增）">
                            <input type="checkbox" class="amily2_opt_concurrent_wb_auto_check" id="${autoId}" data-book="${name}" ${isAuto ? 'checked' : ''} style="margin-right: 5px;">
                            <label for="${autoId}" style="margin-bottom: 0; font-size: 0.9em; opacity: 0.8; cursor: pointer;">全选</label>
                        </div>
                    </div>
                `);
                bookListContainer.append(item);
            });
        } catch (error) {
            console.error(`[${extensionName}] 加载并发世界书失败:`, error);
            bookListContainer.html('<p class="notes" style="color:red;">加载世界书列表失败。</p>');
        }
    }

    // Initial State is now handled by opt_loadConcurrentWorldbookSettings
    updateVisibility();
    if (panel.find('input[name="amily2_plotOpt_concurrentWorldbook_source"]:checked').val() === 'manual') {
        loadConcurrentWorldbooks();
    }

    // Event Listeners
    enabledCheckbox.on('change', function() {
        if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
        extension_settings[extensionName].plotOpt_concurrentWorldbookEnabled = this.checked;
        saveSettingsDebounced();
        updateVisibility();
    });

    sourceRadios.on('change', function() {
        if (this.checked) {
            const source = $(this).val();
            if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
            extension_settings[extensionName].plotOpt_concurrentWorldbookSource = source;
            saveSettingsDebounced();
            updateVisibility();
            if (source === 'manual') {
                loadConcurrentWorldbooks();
            }
        }
    });

    refreshButton.on('click', loadConcurrentWorldbooks);

    bookListContainer.on('change', 'input[type="checkbox"]:not(.amily2_opt_concurrent_wb_auto_check)', function() {
        const selected = [];
        bookListContainer.find('input[type="checkbox"]:not(.amily2_opt_concurrent_wb_auto_check):checked').each(function() {
            selected.push($(this).val());
        });
        if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
        extension_settings[extensionName].plotOpt_concurrentSelectedWorldbooks = selected;
        saveSettingsDebounced();
    });

    bookListContainer.on('change', '.amily2_opt_concurrent_wb_auto_check', function() {
        const autoSelected = [];
        bookListContainer.find('.amily2_opt_concurrent_wb_auto_check:checked').each(function() {
            autoSelected.push($(this).data('book'));
        });
        if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
        extension_settings[extensionName].plotOpt_concurrentAutoSelectWorldbooks = autoSelected;
        saveSettingsDebounced();
    });

    charLimitSlider.on('input', function() {
        const value = $(this).val();
        charLimitValue.text(value);
        if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
        extension_settings[extensionName].plotOpt_concurrentWorldbookCharLimit = parseInt(value, 10);
        saveSettingsDebounced();
    });
}

export function initializePlotOptimizationBindings() {
    const panel = $('#amily2_plot_optimization_panel');
    if (panel.length === 0 || panel.data('events-bound')) {
        return;
    }

    // Tab switching logic
    panel.find('.sinan-navigation-deck').on('click', '.sinan-nav-item', function() {
        const tabButton = $(this);
        const tabName = tabButton.data('tab');
        const contentWrapper = panel.find('.sinan-content-wrapper');

        // Deactivate all tabs and panes
        panel.find('.sinan-nav-item').removeClass('active');
        contentWrapper.find('.sinan-tab-pane').removeClass('active');

        // Activate the clicked tab and corresponding pane
        tabButton.addClass('active');
        contentWrapper.find(`#sinan-${tabName}-tab`).addClass('active');
    });

    // Unified prompt editor logic
    function updateEditorFromCache() {
        const selectedPrompt = panel.find('#amily2_opt_prompt_selector').val();
        if (selectedPrompt) {
            panel.find('#amily2_opt_prompt_editor').val(promptCache[selectedPrompt]);
        }
    }

    // Make it available for opt_loadSettings
    panel.data('initAmily2PromptEditor', function() {
        const settings = opt_getMergedSettings();
        const lastUsedPresetName = settings.plotOpt_lastUsedPresetName;
        const presets = settings.promptPresets || [];
        const lastUsedPreset = presets.find(p => p.name === lastUsedPresetName);

        if (lastUsedPreset) {
            // If a valid preset was last used, load its data into the cache
            promptCache.main = lastUsedPreset.mainPrompt || defaultSettings.plotOpt_mainPrompt;
            promptCache.system = lastUsedPreset.systemPrompt || defaultSettings.plotOpt_systemPrompt;
            promptCache.final_system = lastUsedPreset.finalSystemDirective || defaultSettings.plotOpt_finalSystemDirective;
        } else {
            // Otherwise, load from the base settings (non-preset values)
            promptCache.main = settings.plotOpt_mainPrompt || defaultSettings.plotOpt_mainPrompt;
            promptCache.system = settings.plotOpt_systemPrompt || defaultSettings.plotOpt_systemPrompt;
            promptCache.final_system = settings.plotOpt_finalSystemDirective || defaultSettings.plotOpt_finalSystemDirective;
        }

        updateEditorFromCache();
        panel.find('#amily2_opt_prompt_editor').data('current-prompt', panel.find('#amily2_opt_prompt_selector').val());
    });

    panel.on('change', '#amily2_opt_prompt_selector', function() {
        const previousPromptKey = panel.find('#amily2_opt_prompt_editor').data('current-prompt');
        if (previousPromptKey) {
            const previousValue = panel.find('#amily2_opt_prompt_editor').val();
            promptCache[previousPromptKey] = previousValue;
            const keyMap = {
                main: 'plotOpt_mainPrompt',
                system: 'plotOpt_systemPrompt',
                final_system: 'plotOpt_finalSystemDirective'
            };
            opt_saveSetting(keyMap[previousPromptKey], previousValue);
        }

        const selectedPrompt = $(this).val();
        panel.find('#amily2_opt_prompt_editor').val(promptCache[selectedPrompt]);
        panel.find('#amily2_opt_prompt_editor').data('current-prompt', selectedPrompt);
    });

    panel.on('input', '#amily2_opt_prompt_editor', function() {
        const currentPrompt = panel.find('#amily2_opt_prompt_selector').val();
        const currentValue = $(this).val();
        promptCache[currentPrompt] = currentValue;

        const keyMap = {
            main: 'plotOpt_mainPrompt',
            system: 'plotOpt_systemPrompt',
            final_system: 'plotOpt_finalSystemDirective'
        };
        opt_saveSetting(keyMap[currentPrompt], currentValue);
    });

    panel.on('click', '#amily2_opt_reset_main_prompt', function() {
        const defaultValue = defaultSettings.plotOpt_mainPrompt;
        promptCache.main = defaultValue;
        updateEditorFromCache();
        opt_saveSetting('plotOpt_mainPrompt', defaultValue);
        toastr.info('主提示词已恢复为默认值。');
    });

    panel.on('click', '#amily2_opt_reset_system_prompt', function() {
        const defaultValue = defaultSettings.plotOpt_systemPrompt;
        promptCache.system = defaultValue;
        updateEditorFromCache();
        opt_saveSetting('plotOpt_systemPrompt', defaultValue);
        toastr.info('拦截任务指令已恢复为默认值。');
    });

    panel.on('click', '#amily2_opt_reset_final_system_directive', function() {
        const defaultValue = defaultSettings.plotOpt_finalSystemDirective;
        promptCache.final_system = defaultValue;
        updateEditorFromCache();
        opt_saveSetting('plotOpt_finalSystemDirective', defaultValue);
        toastr.info('最终注入指令已恢复为默认值。');
    });

    opt_loadSettings(panel);
    bindJqyhApiEvents();
    bindConcurrentApiEvents();
    bindConcurrentPromptEvents();
    opt_loadConcurrentWorldbookSettings(); // Load settings
    bindConcurrentWorldbookEvents(); // Then bind events

    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log(`[${extensionName}] 检测到角色/聊天切换，正在刷新剧情优化设置UI...`);
        opt_loadSettings(panel);
    });

    const refreshWorldbookUI = () => {
        if (panel.is(':visible')) {
            console.log(`[${extensionName}] 检测到世界书变更，正在刷新列表...`);
            opt_loadWorldbooks(panel).then(() => {
                opt_loadWorldbookEntries(panel);
            });
        }
    };

    eventSource.on(event_types.WORLDINFO_UPDATED, refreshWorldbookUI);
    // 尝试监听更多可能的世界书事件，确保第一时间更新
    if (event_types.WORLDINFO_ENTRY_UPDATED) eventSource.on(event_types.WORLDINFO_ENTRY_UPDATED, refreshWorldbookUI);
    if (event_types.WORLDINFO_ENTRY_CREATED) eventSource.on(event_types.WORLDINFO_ENTRY_CREATED, refreshWorldbookUI);
    if (event_types.WORLDINFO_ENTRY_DELETED) eventSource.on(event_types.WORLDINFO_ENTRY_DELETED, refreshWorldbookUI);

    const handleSettingChange = function(element) {
        const el = $(element);
        const key_part = (element.name || element.id).replace('amily2_opt_', '');
        const key = 'plotOpt_' + key_part.replace(/_([a-z])/g, (g) => g[1].toUpperCase());

        let value = element.type === 'checkbox' ? element.checked : el.val();

        if (key === 'plotOpt_selected_worldbooks' && !Array.isArray(value)) {
            value = el.val() || [];
        }

        const floatKeys = ['plotOpt_temperature', 'plotOpt_top_p', 'plotOpt_presence_penalty', 'plotOpt_frequency_penalty', 'plotOpt_rateMain', 'plotOpt_ratePersonal', 'plotOpt_rateErotic', 'plotOpt_rateCuckold'];
        if (floatKeys.includes(key) && value !== '') {
            value = parseFloat(value);
        } else if (element.type === 'range' || element.type === 'number') {
            if (value !== '') value = parseInt(value, 10);
        }

        if (value !== '' || element.type === 'checkbox') {
             opt_saveSetting(key, value);
        }

        if (key === 'plotOpt_api_mode') {
            opt_updateApiUrlVisibility(panel, value);
        }

        if (element.name === 'amily2_opt_worldbook_source') {
            opt_updateWorldbookSourceVisibility(panel, value);
            opt_loadWorldbookEntries(panel);
        }
    };
    const allInputSelectors = [
        'input[type="checkbox"]', 'input[type="radio"]', 'select:not(#amily2_opt_model_select)',
        'input[type="text"]', 'input[type="password"]', 'textarea',
        'input[type="range"]', 'input[type="number"]'
    ].join(', ');

    panel.on('input.amily2_opt change.amily2_opt', allInputSelectors, function() {
        handleSettingChange(this);
    });

    panel.on('change.amily2_opt', '#amily2_opt_model_select', function() {
        const selectedModel = $(this).val();
        if (selectedModel) {
            panel.find('#amily2_opt_model').val(selectedModel).trigger('change');
        }
    });


    panel.on('click.amily2_opt', '#amily2_opt_refresh_tavern_api_profiles', () => {
        opt_loadTavernApiProfiles(panel);
    });

    panel.on('change.amily2_opt', '#amily2_opt_tavern_api_profile_select', function() {
        const value = $(this).val();
        opt_saveSetting('tavernProfile', value);
    });


    panel.find('#amily2_opt_import_prompt_presets').on('click', () => panel.find('#amily2_opt_preset_file_input').click());
    panel.find('#amily2_opt_export_prompt_presets').on('click', () => opt_exportPromptPresets());
    panel.find('#amily2_opt_save_prompt_preset').on('click', () => opt_saveCurrentPromptsAsPreset(panel));
    panel.find('#amily2_opt_delete_prompt_preset').on('click', () => opt_deleteSelectedPreset(panel));

    panel.on('change.amily2_opt', '#amily2_opt_preset_file_input', function(e) {
        opt_importPromptPresets(e.target.files[0], panel);
    });

    panel.on('change.amily2_opt', '#amily2_opt_prompt_preset_select', function(event, data) {
        const selectedName = $(this).val();
        const deleteBtn = panel.find('#amily2_opt_delete_prompt_preset');
        const isAutomatic = data && data.isAutomatic;
        const noLoad = data && data.noLoad;

        console.log('[Amily2-Debug] Preset select changed:', selectedName, 'isAutomatic:', isAutomatic, 'noLoad:', noLoad);
        opt_saveSetting('plotOpt_lastUsedPresetName', selectedName);
        console.log('[Amily2-Debug] After saving, extension_settings contains:', extension_settings[extensionName]?.plotOpt_lastUsedPresetName);

        // On initial load, we might not need to reload all the data, just update the UI state.
        if (noLoad) {
            if (selectedName) deleteBtn.show();
            else deleteBtn.hide();
            return;
        }

        if (!selectedName) {
            deleteBtn.hide();
            opt_saveSetting('lastUsedPresetName', '');
            return;
        }

        const presets = extension_settings[extensionName]?.promptPresets || [];
        const selectedPreset = presets.find(p => p.name === selectedName);

        if (selectedPreset) {
            // Update cache with preset values
            promptCache.main = selectedPreset.mainPrompt || defaultSettings.plotOpt_mainPrompt;
            promptCache.system = selectedPreset.systemPrompt || defaultSettings.plotOpt_systemPrompt;
            promptCache.final_system = selectedPreset.finalSystemDirective || defaultSettings.plotOpt_finalSystemDirective;

            // Update the editor to show the content of the currently selected prompt type
            const initFunc = panel.data('initAmily2PromptEditor');
            if (initFunc) {
                initFunc();
            }

            // Save the new prompt values to the main settings
            opt_saveSetting('plotOpt_mainPrompt', promptCache.main);
            opt_saveSetting('plotOpt_systemPrompt', promptCache.system);
            opt_saveSetting('plotOpt_finalSystemDirective', promptCache.final_system);

            // Also load and save concurrent prompts
            const concurrentMain = selectedPreset.concurrentMainPrompt || defaultSettings.plotOpt_concurrentMainPrompt;
            const concurrentSystem = selectedPreset.concurrentSystemPrompt || defaultSettings.plotOpt_concurrentSystemPrompt;
            opt_saveSetting('plotOpt_concurrentMainPrompt', concurrentMain);
            opt_saveSetting('plotOpt_concurrentSystemPrompt', concurrentSystem);

            // Trigger UI update for concurrent editor
            const concurrentEditor = panel.find('#amily2_concurrent_prompt_editor');
            const concurrentSelector = panel.find('#amily2_concurrent_prompt_selector');
            if (concurrentSelector.val() === 'main') {
                concurrentEditor.val(concurrentMain);
            } else {
                concurrentEditor.val(concurrentSystem);
            }

            panel.find('#amily2_opt_rate_main').val(selectedPreset.rateMain ?? 1.0).trigger('change');
            panel.find('#amily2_opt_rate_personal').val(selectedPreset.ratePersonal ?? 1.0).trigger('change');
            panel.find('#amily2_opt_rate_erotic').val(selectedPreset.rateErotic ?? 1.0).trigger('change');
            panel.find('#amily2_opt_rate_cuckold').val(selectedPreset.rateCuckold ?? 1.0).trigger('change');

            if (!isAutomatic) {
                toastr.success(`已加载预设 "${selectedName}"。`);
            }
            deleteBtn.show();
        } else {
            deleteBtn.hide();
        }
    });

    panel.data('events-bound', true);
    console.log(`[${extensionName}] 剧情优化UI事件已成功绑定，自动保存已激活。`);

    panel.on('click.amily2_opt', '#amily2_opt_refresh_worldbooks', () => {
        opt_loadWorldbooks(panel).then(() => {
            opt_loadWorldbookEntries(panel);
        });
    });


    // Manual Selection Change
    panel.on('change.amily2_opt', '#amily2_opt_worldbook_checkbox_list input[type="checkbox"]:not(.amily2_opt_wb_auto_check)', async function() {
        const selected = [];
        panel.find('#amily2_opt_worldbook_checkbox_list input[type="checkbox"]:not(.amily2_opt_wb_auto_check):checked').each(function() {
            selected.push($(this).val());
        });

        await opt_saveSetting('plotOpt_selectedWorldbooks', selected);
        await opt_loadWorldbookEntries(panel);
    });

    // Auto Selection Change
    panel.on('change.amily2_opt', '#amily2_opt_worldbook_checkbox_list input.amily2_opt_wb_auto_check', async function() {
        const autoSelected = [];
        panel.find('#amily2_opt_worldbook_checkbox_list input.amily2_opt_wb_auto_check:checked').each(function() {
            autoSelected.push($(this).data('book'));
        });

        await opt_saveSetting('plotOpt_autoSelectWorldbooks', autoSelected);
        await opt_loadWorldbookEntries(panel);
    });

    panel.on('change.amily2_opt', '#amily2_opt_worldbook_entry_list_container input[type="checkbox"]', () => {
        opt_saveEnabledEntries();
    });

    panel.on('click.amily2_opt', '#amily2_opt_worldbook_entry_select_all', () => {
        panel.find('#amily2_opt_worldbook_entry_list_container input[type="checkbox"]').prop('checked', true);
        opt_saveEnabledEntries();
    });

    panel.on('click.amily2_opt', '#amily2_opt_worldbook_entry_deselect_all', () => {
        panel.find('#amily2_opt_worldbook_entry_list_container input[type="checkbox"]').prop('checked', false);
        opt_saveEnabledEntries();
    });
}

// ========== Jqyh API 事件绑定函数 ==========
function bindJqyhApiEvents() {
    console.log("[Amily2号-Jqyh工部] 正在绑定Jqyh API事件...");

    const updateAndSaveSetting = (key, value) => {
        console.log(`[Amily2-Jqyh令] 收到指令: 将 [${key}] 设置为 ->`, value);
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {};
        }
        extension_settings[extensionName][key] = value;
        saveSettingsDebounced();
        console.log(`[Amily2-Jqyh录] [${key}] 的新状态已保存。`);
    };

    // Jqyh API 开关控制
    const jqyhToggle = document.getElementById('amily2_jqyh_enabled');
    const jqyhContent = document.getElementById('amily2_jqyh_content');

    if (jqyhToggle && jqyhContent) {
        jqyhToggle.checked = extension_settings[extensionName].jqyhEnabled ?? false;
        jqyhContent.style.display = jqyhToggle.checked ? 'block' : 'none';

        jqyhToggle.addEventListener('change', function() {
            const isEnabled = this.checked;
            updateAndSaveSetting('jqyhEnabled', isEnabled);
            jqyhContent.style.display = isEnabled ? 'block' : 'none';
        });
    }

    // API模式切换
    const apiModeSelect = document.getElementById('amily2_jqyh_api_mode');
    const compatibleConfig = document.getElementById('amily2_jqyh_compatible_config');
    const presetConfig = document.getElementById('amily2_jqyh_preset_config');

    if (apiModeSelect && compatibleConfig && presetConfig) {
        apiModeSelect.value = extension_settings[extensionName].jqyhApiMode || 'openai_test';

        const updateConfigVisibility = (mode) => {
            if (mode === 'sillytavern_preset') {
                compatibleConfig.style.display = 'none';
                presetConfig.style.display = 'block';
                loadJqyhTavernPresets();
            } else {
                compatibleConfig.style.display = 'block';
                presetConfig.style.display = 'none';
            }
        };

        updateConfigVisibility(apiModeSelect.value);

        apiModeSelect.addEventListener('change', function() {
            updateAndSaveSetting('jqyhApiMode', this.value);
            updateConfigVisibility(this.value);
        });
    }

    // API配置字段绑定
    const apiFields = [
        { id: 'amily2_jqyh_api_url', key: 'jqyhApiUrl' },
        { id: 'amily2_jqyh_api_key', key: 'jqyhApiKey', sensitive: true },
        { id: 'amily2_jqyh_model', key: 'jqyhModel' }
    ];

    apiFields.forEach(field => {
        const element = document.getElementById(field.id);
        if (element) {
            // 敏感字段（API Key）从 configManager（localStorage）读取
            element.value = field.sensitive
                ? (configManager.get(field.key) || '')
                : (extension_settings[extensionName][field.key] || '');
            element.addEventListener('change', function() {
                if (field.sensitive) {
                    configManager.set(field.key, this.value);
                } else {
                    updateAndSaveSetting(field.key, this.value);
                }
            });
        }
    });

    // 滑块控件绑定
    const sliderFields = [
        { id: 'amily2_jqyh_max_tokens', key: 'jqyhMaxTokens', defaultValue: 4000 },
        { id: 'amily2_jqyh_temperature', key: 'jqyhTemperature', defaultValue: 0.7 }
    ];

    sliderFields.forEach(field => {
        const slider = document.getElementById(field.id);
        const display = document.getElementById(field.id + '_value');
        if (slider && display) {
            const value = extension_settings[extensionName][field.key] || field.defaultValue;
            slider.value = value;
            display.textContent = value;

            slider.addEventListener('input', function() {
                const newValue = parseFloat(this.value);
                display.textContent = newValue;
                updateAndSaveSetting(field.key, newValue);
            });
        }
    });

    // SillyTavern预设选择器
    const tavernProfileSelect = document.getElementById('amily2_jqyh_tavern_profile');
    if (tavernProfileSelect) {
        tavernProfileSelect.value = extension_settings[extensionName].jqyhTavernProfile || '';
        tavernProfileSelect.addEventListener('change', function() {
            updateAndSaveSetting('jqyhTavernProfile', this.value);
        });
    }

    // 测试连接按钮
    const testButton = document.getElementById('amily2_jqyh_test_connection');
    if (testButton) {
        testButton.addEventListener('click', async function() {
            const button = $(this);
            const originalHtml = button.html();
            button.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 测试中');

            try {
                await testJqyhApiConnection();
            } catch (error) {
                console.error('[Amily2号-Jqyh] 测试连接失败:', error);
            } finally {
                button.prop('disabled', false).html(originalHtml);
            }
        });
    }

    const fetchModelsButton = document.getElementById('amily2_jqyh_fetch_models');
    const modelSelect = document.getElementById('amily2_jqyh_model_select');
    const modelInput = document.getElementById('amily2_jqyh_model');

    if (fetchModelsButton && modelSelect && modelInput) {
        fetchModelsButton.addEventListener('click', async function() {
            const button = $(this);
            const originalHtml = button.html();
            button.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 获取中');

            try {
                const models = await fetchJqyhModels();

                if (models && models.length > 0) {
                    modelSelect.innerHTML = '<option value="">-- 请选择模型 --</option>';
                    models.forEach(model => {
                        const option = document.createElement('option');
                        option.value = model.id || model.name || model;
                        option.textContent = model.name || model.id || model;
                        modelSelect.appendChild(option);
                    });
                    modelSelect.style.display = 'block';
                    modelInput.style.display = 'none';

                    modelSelect.addEventListener('change', function() {
                        const selectedModel = this.value;
                        modelInput.value = selectedModel;
                        updateAndSaveSetting('jqyhModel', selectedModel);
                        console.log(`[Amily2-Jqyh] 已选择模型: ${selectedModel}`);
                    });

                    toastr.success(`成功获取 ${models.length} 个模型`, 'Jqyh 模型获取');
                } else {
                    toastr.warning('未获取到任何模型', 'Jqyh 模型获取');
                }

            } catch (error) {
                console.error('[Amily2号-Jqyh] 获取模型列表失败:', error);
                toastr.error(`获取模型失败: ${error.message}`, 'Jqyh 模型获取');
            } finally {
                button.prop('disabled', false).html(originalHtml);
            }
        });
    }
}

async function loadJqyhTavernPresets() {
    const select = document.getElementById('amily2_jqyh_tavern_profile');
    if (!select) return;

    const currentValue = select.value;
    select.innerHTML = '<option value="">-- 加载中 --</option>';

    try {
        const context = getContext();
        const tavernProfiles = context.extensionSettings?.connectionManager?.profiles || [];

        select.innerHTML = '<option value="">-- 请选择预设 --</option>';

        if (tavernProfiles.length > 0) {
            tavernProfiles.forEach(profile => {
                if (profile.api && profile.preset) {
                    const option = document.createElement('option');
                    option.value = profile.id;
                    option.textContent = profile.name || profile.id;
                    if (profile.id === currentValue) {
                        option.selected = true;
                    }
                    select.appendChild(option);
                }
            });
        } else {
            select.innerHTML = '<option value="">未找到可用预设</option>';
        }
    } catch (error) {
        console.error('[Amily2号-Jqyh] 加载SillyTavern预设失败:', error);
        select.innerHTML = '<option value="">加载失败</option>';
    }
}

// ========== 图标位置切换（跨模块通用事件） ==========
$(document).on('change', 'input[name="amily2_icon_location"]', function() {
    if (!pluginAuthStatus.authorized) return;
    const newLocation = $(this).val();
    extension_settings[extensionName]['iconLocation'] = newLocation;
    saveSettingsDebounced();
    console.log(`[Amily-禁卫军] 收到迁都指令 -> ${newLocation}。圣意已存档。`);
    toastr.info(`正在将帝国徽记迁往 [${newLocation === 'topbar' ? '顶栏' : '扩展区'}]...`, "迁都令", { timeOut: 2000 });
    $('#amily2_main_drawer').remove();
    $(document).off("mousedown.amily2Drawer");
    $('#amily2_extension_frame').remove();

    setTimeout(createDrawer, 50);
});
