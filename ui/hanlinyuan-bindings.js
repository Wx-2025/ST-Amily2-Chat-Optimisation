import { extension_settings, getContext } from "/scripts/extensions.js";
import {
  extensionName,
  defaultSettings,
  saveSettings,
} from "../utils/settings.js";
import { showHtmlModal } from './page-window.js';
import { applyExclusionRules, extractBlocksByTags } from '../core/utils/rag-tag-extractor.js';

import {
  getAvailableWorldbooks, getLoresForWorldbook,
  executeManualSummary, executeRefinement,
  executeExpedition, stopExpedition 
} from "../core/historiographer.js";

import { getNgmsApiSettings, testNgmsApiConnection, fetchNgmsModels } from "../core/api/Ngms_api.js";


function setupPromptEditor(type) {
  const selector = document.getElementById(
    `amily2_mhb_${type}_prompt_selector`,
  );
  const editor = document.getElementById(`amily2_mhb_${type}_editor`);
  const saveBtn = document.getElementById(`amily2_mhb_${type}_save_button`);
  const restoreBtn = document.getElementById(
    `amily2_mhb_${type}_restore_button`,
  );

  const jailbreakKey =
    type === "small"
      ? "historiographySmallJailbreakPrompt"
      : "historiographyLargeJailbreakPrompt";
  const mainPromptKey =
    type === "small"
      ? "historiographySmallSummaryPrompt"
      : "historiographyLargeRefinePrompt";

  const updateEditorView = () => {
    const selected = selector.value;
    if (selected === "jailbreak") {
      editor.value = extension_settings[extensionName][jailbreakKey];
    } else {
      editor.value = extension_settings[extensionName][mainPromptKey];
    }
  };

  selector.addEventListener("change", updateEditorView);

  saveBtn.addEventListener("click", () => {
    const selected = selector.value;
    if (selected === "jailbreak") {
      extension_settings[extensionName][jailbreakKey] = editor.value;
    } else {
      extension_settings[extensionName][mainPromptKey] = editor.value;
    }
    if (saveSettings()) {
      toastr.success(
        `${type === "small" ? "微言录" : "宏史卷"}的${selected === "jailbreak" ? "破限谕旨" : "纲要"}已保存！`,
      );
    }
  });

  restoreBtn.addEventListener("click", () => {
    const selected = selector.value;
    if (selected === "jailbreak") {
      editor.value = defaultSettings[jailbreakKey];
    } else {
      editor.value = defaultSettings[mainPromptKey];
    }
    toastr.info("已恢复为默认谕旨，请点击“保存当前”以确认。");
  });

      updateEditorView();


    const expandBtn = document.getElementById(`amily2_mhb_${type}_expand_editor`);

    expandBtn.addEventListener('click', () => {
        const selectedValue = selector.value;
        const selectedText = selector.options[selector.selectedIndex].text; 
        const currentContent = editor.value;

        const dialogHtml = `
            <dialog class="popup wide_dialogue_popup large_dialogue_popup">
              <div class="popup-body">
                <h4 style="margin-top:0; color: #eee; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 10px;">正在编辑: ${selectedText}</h4>
                <div class="popup-content" style="height: 70vh;"><div class="height100p wide100p flex-container"><textarea class="height100p wide100p maximized_textarea text_pole"></textarea></div></div>
                <div class="popup-controls"><div class="popup-button-ok menu_button menu_button_primary interactable">保存并关闭</div><div class="popup-button-cancel menu_button interactable" style="margin-left: 10px;">取消</div></div>
              </div>
            </dialog>`;

        const dialogElement = $(dialogHtml).appendTo('body');
        const dialogTextarea = dialogElement.find('textarea');
        dialogTextarea.val(currentContent);

        const closeDialog = () => { dialogElement[0].close(); dialogElement.remove(); };

        dialogElement.find('.popup-button-ok').on('click', () => {
            const newContent = dialogTextarea.val();
            editor.value = newContent;
            if (selectedValue === "jailbreak") {
                extension_settings[extensionName][jailbreakKey] = newContent;
            } else {
                extension_settings[extensionName][mainPromptKey] = newContent;
            }
            if (saveSettings()) {
                toastr.success(`${type === 'small' ? '微言录' : '宏史卷'}的${selectedText}已镌刻！`);
            }
            closeDialog();
        });

        dialogElement.find('.popup-button-cancel').on('click', closeDialog);
        dialogElement[0].showModal();
    });

}

export function bindHistoriographyEvents() {
    console.log("[Amily2号-工部] 【敕史局】的专属工匠已就位...");

    setupPromptEditor("small");
    setupPromptEditor("large");
    
    // ========== 🛰️ Ngms API 系统绑定 ==========
    bindNgmsApiEvents();

    // ========== 📜 微言录 (Small Summary) 绑定 (无改动) ==========
    const smallStartFloor = document.getElementById("amily2_mhb_small_start_floor");
    const smallEndFloor = document.getElementById("amily2_mhb_small_end_floor");
    const smallExecuteBtn = document.getElementById("amily2_mhb_small_manual_execute");
    const smallAutoEnable = document.getElementById("amily2_mhb_small_auto_enabled");
    const smallTriggerThreshold = document.getElementById("amily2_mhb_small_trigger_count");
    const writeToLorebook = document.getElementById("historiography_write_to_lorebook");
    const ingestToRag = document.getElementById("historiography_ingest_to_rag");

    smallExecuteBtn.addEventListener("click", () => {
        const start = parseInt(smallStartFloor.value, 10);
        const end = parseInt(smallEndFloor.value, 10);
        if (isNaN(start) || isNaN(end) || start <= 0 || end <= 0 || start > end) {
            toastr.error("请输入有效的起始和结束楼层！", "圣谕有误");
            return;
        }
        executeManualSummary(start, end);
    });

    smallAutoEnable.addEventListener("change", (event) => {
        extension_settings[extensionName].historiographySmallAutoEnable = event.target.checked;
        saveSettings();
    });

    smallTriggerThreshold.addEventListener("change", (event) => {
        const value = parseInt(event.target.value, 10);
        if (isNaN(value) || value < 1) {

            event.target.value = defaultSettings.historiographySmallTriggerThreshold;
            toastr.warning("远征阈值必须是大于0的数字。已重置。", "圣谕有误");
            return; 
        }
        extension_settings[extensionName].historiographySmallTriggerThreshold = value;
        saveSettings();
    });

    writeToLorebook.addEventListener("change", (event) => {
        extension_settings[extensionName].historiographyWriteToLorebook = event.target.checked;
        saveSettings();
    });

    ingestToRag.addEventListener("change", (event) => {
        extension_settings[extensionName].historiographyIngestToRag = event.target.checked;
        saveSettings();
    });


    smallAutoEnable.checked = extension_settings[extensionName].historiographySmallAutoEnable ?? false;
    smallTriggerThreshold.value = extension_settings[extensionName].historiographySmallTriggerThreshold ?? 30;
    writeToLorebook.checked = extension_settings[extensionName].historiographyWriteToLorebook ?? true;
    ingestToRag.checked = extension_settings[extensionName].historiographyIngestToRag ?? false;

    const autoSummaryInteractive = document.getElementById("historiography_auto_summary_interactive");
    autoSummaryInteractive.checked = extension_settings[extensionName].historiographyAutoSummaryInteractive ?? false;
    autoSummaryInteractive.addEventListener("change", (event) => {
        extension_settings[extensionName].historiographyAutoSummaryInteractive = event.target.checked;
        saveSettings();
    });

    // ========== 🏷️ 标签与排除规则绑定 (新增) ==========
    const tagExtractionToggle = document.getElementById("historiography-tag-extraction-toggle");
    const tagInputContainer = document.getElementById("historiography-tag-input-container");
    const tagInput = document.getElementById("historiography-tag-input");
    const exclusionRulesBtn = document.getElementById("historiography-exclusion-rules-btn");

    tagExtractionToggle.checked = extension_settings[extensionName].historiographyTagExtractionEnabled ?? false;
    tagInput.value = extension_settings[extensionName].historiographyTags ?? '';
    tagInputContainer.style.display = tagExtractionToggle.checked ? 'block' : 'none';

    tagExtractionToggle.addEventListener("change", (event) => {
        const isEnabled = event.target.checked;
        extension_settings[extensionName].historiographyTagExtractionEnabled = isEnabled;
        tagInputContainer.style.display = isEnabled ? 'block' : 'none';
        saveSettings();
    });

    tagInput.addEventListener("change", (event) => {
        extension_settings[extensionName].historiographyTags = event.target.value;
        saveSettings();
    });
    
    exclusionRulesBtn.addEventListener("click", showHistoriographyExclusionRulesModal);


    const expeditionExecuteBtn = document.getElementById("amily2_mhb_small_expedition_execute");

    const updateExpeditionButtonUI = (state) => {
        expeditionExecuteBtn.dataset.state = state; 
        switch (state) {
            case 'running':
                expeditionExecuteBtn.innerHTML = '<i class="fas fa-stop-circle"></i> 停止远征';
                expeditionExecuteBtn.className = 'menu_button small_button interactable danger';
                break;
            case 'paused':
                expeditionExecuteBtn.innerHTML = '<i class="fas fa-play-circle"></i> 继续远征';
                expeditionExecuteBtn.className = 'menu_button small_button interactable success';
                break;
            case 'idle':
            default:
                expeditionExecuteBtn.innerHTML = '<i class="fas fa-flag-checkered"></i> 开始远征';
                expeditionExecuteBtn.className = 'menu_button small_button interactable'; 
                break;
        }
    };

    document.addEventListener('amily2-expedition-state-change', (e) => {
        const { isRunning, manualStop } = e.detail;
        if (isRunning) {
            updateExpeditionButtonUI('running');
        } else if (manualStop) {
            updateExpeditionButtonUI('paused');
        } else {
            updateExpeditionButtonUI('idle');
        }
    });

    expeditionExecuteBtn.addEventListener("click", () => {
        const currentState = expeditionExecuteBtn.dataset.state || 'idle';
        if (currentState === 'running') {
            stopExpedition(); 
        } else {
            executeExpedition(); 
        }
    });

    updateExpeditionButtonUI('idle');

  // ========== 💎 宏史卷 (史册精炼) 绑定 ==========
  const largeWbSelector = document.getElementById(
    "amily2_mhb_large_worldbook_selector",
  );
  const largeLoreSelector = document.getElementById(
    "amily2_mhb_large_lore_selector",
  );
  const largeRefreshWbBtn = document.getElementById(
    "amily2_mhb_large_refresh_worldbooks",
  );
  const largeRefreshLoresBtn = document.getElementById(
    "amily2_mhb_large_refresh_lores",
  );
  const largeRefineBtn = document.getElementById(
    "amily2_mhb_large_refine_execute",
  );

  const updateWorldbookList = async () => {
    largeWbSelector.innerHTML = '<option value="">正在遍览帝国疆域...</option>';
    const worldbooks = await getAvailableWorldbooks();
    largeWbSelector.innerHTML = ""; // 清空
    if (worldbooks && worldbooks.length > 0) {
      worldbooks.forEach((wb) => {
        const option = document.createElement("option");
        option.value = wb;
        option.textContent = wb;
        largeWbSelector.appendChild(option);
      });

      largeWbSelector.dispatchEvent(new Event("change"));
    } else {
      largeWbSelector.innerHTML = '<option value="">未发现任何国史馆</option>';
    }
  };

  const updateLoreList = async () => {
    const selectedWb = largeWbSelector.value;
    if (!selectedWb) {
      largeLoreSelector.innerHTML = '<option value="">请先选择国史馆</option>';
      return;
    }
    largeLoreSelector.innerHTML = '<option value="">正在检阅史册...</option>';
    const lores = await getLoresForWorldbook(selectedWb);
    largeLoreSelector.innerHTML = ""; // 清空
    if (lores && lores.length > 0) {
      lores.forEach((lore) => {
        const option = document.createElement("option");
        option.value = lore.key;
        option.textContent = `[${lore.key}] ${lore.comment}`;
        largeLoreSelector.appendChild(option);
      });
    } else {
      largeLoreSelector.innerHTML = '<option value="">此国史馆为空</option>';
    }
  };

  largeRefreshWbBtn.addEventListener("click", updateWorldbookList);
  largeWbSelector.addEventListener("change", updateLoreList);
  largeRefreshLoresBtn.addEventListener("click", updateLoreList);

  largeRefineBtn.addEventListener("click", () => {
    const worldbook = largeWbSelector.value;
    const loreKey = largeLoreSelector.value;
    if (!worldbook || !loreKey) {
      toastr.error("请先选择一个国史馆及其中的史册条目！", "圣谕不全");
      return;
    }

    executeRefinement(worldbook, loreKey);
  });


  const vectorizeSummaryContent = document.getElementById("amily2_vectorize_summary_content");
  vectorizeSummaryContent.checked = extension_settings[extensionName].historiographyVectorizeSummary ?? false;
  vectorizeSummaryContent.addEventListener("change", (event) => {
      extension_settings[extensionName].historiographyVectorizeSummary = event.target.checked;
      saveSettings();
  });
}


// ========== Ngms API 事件绑定函数 ==========
function bindNgmsApiEvents() {
    console.log("[Amily2号-Ngms工部] 正在绑定Ngms API事件...");

    const updateAndSaveSetting = (key, value) => {
        console.log(`[Amily2-Ngms令] 收到指令: 将 [${key}] 设置为 ->`, value);
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {};
        }
        extension_settings[extensionName][key] = value;
        saveSettings();
        console.log(`[Amily2-Ngms录] [${key}] 的新状态已保存。`);
    };

    // Ngms API 开关控制
    const ngmsToggle = document.getElementById('amily2_ngms_enabled');
    const ngmsContent = document.getElementById('amily2_ngms_content');
    
    if (ngmsToggle && ngmsContent) {
        ngmsToggle.checked = extension_settings[extensionName].ngmsEnabled ?? false;
        ngmsContent.style.display = ngmsToggle.checked ? 'block' : 'none';

        ngmsToggle.addEventListener('change', function() {
            const isEnabled = this.checked;
            updateAndSaveSetting('ngmsEnabled', isEnabled);
            ngmsContent.style.display = isEnabled ? 'block' : 'none';
        });
    }

    // API模式切换
    const apiModeSelect = document.getElementById('amily2_ngms_api_mode');
    const compatibleConfig = document.getElementById('amily2_ngms_compatible_config');
    const presetConfig = document.getElementById('amily2_ngms_preset_config');

    if (apiModeSelect && compatibleConfig && presetConfig) {
        apiModeSelect.value = extension_settings[extensionName].ngmsApiMode || 'openai_test';
        
        const updateConfigVisibility = (mode) => {
            if (mode === 'sillytavern_preset') {
                compatibleConfig.style.display = 'none';
                presetConfig.style.display = 'block';
                loadNgmsTavernPresets();
            } else {
                compatibleConfig.style.display = 'block';
                presetConfig.style.display = 'none';
            }
        };

        updateConfigVisibility(apiModeSelect.value);

        apiModeSelect.addEventListener('change', function() {
            updateAndSaveSetting('ngmsApiMode', this.value);
            updateConfigVisibility(this.value);
        });
    }

    // API配置字段绑定
    const apiFields = [
        { id: 'amily2_ngms_api_url', key: 'ngmsApiUrl' },
        { id: 'amily2_ngms_api_key', key: 'ngmsApiKey' },
        { id: 'amily2_ngms_model', key: 'ngmsModel' }
    ];

    apiFields.forEach(field => {
        const element = document.getElementById(field.id);
        if (element) {
            element.value = extension_settings[extensionName][field.key] || '';
            element.addEventListener('change', function() {
                updateAndSaveSetting(field.key, this.value);
            });
        }
    });

    // 滑块控件绑定
    const sliderFields = [
        { id: 'amily2_ngms_max_tokens', key: 'ngmsMaxTokens', defaultValue: 4000 },
        { id: 'amily2_ngms_temperature', key: 'ngmsTemperature', defaultValue: 0.7 }
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
    const tavernProfileSelect = document.getElementById('amily2_ngms_tavern_profile');
    if (tavernProfileSelect) {
        tavernProfileSelect.value = extension_settings[extensionName].ngmsTavernProfile || '';
        tavernProfileSelect.addEventListener('change', function() {
            updateAndSaveSetting('ngmsTavernProfile', this.value);
        });
    }

    // 测试连接按钮
    const testButton = document.getElementById('amily2_ngms_test_connection');
    if (testButton) {
        testButton.addEventListener('click', async function() {
            const button = $(this);
            const originalHtml = button.html();
            button.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 测试中');
            
            try {
                await testNgmsApiConnection();
            } catch (error) {
                console.error('[Amily2号-Ngms] 测试连接失败:', error);
            } finally {
                button.prop('disabled', false).html(originalHtml);
            }
        });
    }

    // 获取模型按钮
    const fetchModelsButton = document.getElementById('amily2_ngms_fetch_models');
    const modelSelect = document.getElementById('amily2_ngms_model_select');
    const modelInput = document.getElementById('amily2_ngms_model');
    
    if (fetchModelsButton && modelSelect && modelInput) {
        fetchModelsButton.addEventListener('click', async function() {
            const button = $(this);
            const originalHtml = button.html();
            button.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 获取中');
            
            try {
                const models = await fetchNgmsModels();
                
                if (models && models.length > 0) {
                    // 清空并填充模型下拉框
                    modelSelect.innerHTML = '<option value="">-- 请选择模型 --</option>';
                    models.forEach(model => {
                        const option = document.createElement('option');
                        option.value = model.id || model.name || model;
                        option.textContent = model.name || model.id || model;
                        modelSelect.appendChild(option);
                    });
                    
                    // 显示下拉框，隐藏输入框
                    modelSelect.style.display = 'block';
                    modelInput.style.display = 'none';
                    
                    // 绑定模型选择事件
                    modelSelect.addEventListener('change', function() {
                        const selectedModel = this.value;
                        modelInput.value = selectedModel;
                        updateAndSaveSetting('ngmsModel', selectedModel);
                        console.log(`[Amily2-Ngms] 已选择模型: ${selectedModel}`);
                    });
                    
                    toastr.success(`成功获取 ${models.length} 个模型`, 'Ngms 模型获取');
                } else {
                    toastr.warning('未获取到任何模型', 'Ngms 模型获取');
                }
                
            } catch (error) {
                console.error('[Amily2号-Ngms] 获取模型列表失败:', error);
                toastr.error(`获取模型失败: ${error.message}`, 'Ngms 模型获取');
            } finally {
                button.prop('disabled', false).html(originalHtml);
            }
        });
    }
}

// 加载SillyTavern预设列表
async function loadNgmsTavernPresets() {
    const select = document.getElementById('amily2_ngms_tavern_profile');
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
        console.error('[Amily2号-Ngms] 加载SillyTavern预设失败:', error);
        select.innerHTML = '<option value="">加载失败</option>';
    }
}

function showHistoriographyExclusionRulesModal() {
    const rules = extension_settings[extensionName].historiographyExclusionRules || [];

    const createRuleRowHtml = (rule = { start: '', end: '' }, index) => `
        <div class="hly-exclusion-rule-row" data-index="${index}">
            <input type="text" class="hly-imperial-brush" value="${rule.start}" placeholder="开始字符, 如 <!--">
            <span>到</span>
            <input type="text" class="hly-imperial-brush" value="${rule.end}" placeholder="结束字符, 如 -->">
            <button class="hly-delete-rule-btn" title="删除此规则">&times;</button>
        </div>
    `;

    const rulesHtml = rules.map(createRuleRowHtml).join('');

    const modalHtml = `
        <div id="historiography-exclusion-rules-container">
            <p class="hly-notes">在这里定义需要从提取内容中排除的文本片段。例如，排除HTML注释，可以设置开始字符为 \`<!--\`，结束字符为 \`-->\`。</p>
            <div id="historiography-rules-list">${rulesHtml}</div>
            <button id="historiography-add-rule-btn" class="hly-action-button" style="margin-top: 10px;">
                <i class="fas fa-plus"></i> 添加新规则
            </button>
        </div>
        <style>
            .hly-exclusion-rule-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
            .hly-exclusion-rule-row input { flex-grow: 1; }
            .hly-delete-rule-btn { background: #c0392b; color: white; border: none; border-radius: 50%; width: 24px; height: 24px; cursor: pointer; font-size: 16px; line-height: 24px; text-align: center; padding: 0; }
        </style>
    `;

    showHtmlModal('编辑内容排除规则', modalHtml, {
        okText: '保存规则',
        onOk: (dialogElement) => {
            const newRules = [];
            dialogElement.find('.hly-exclusion-rule-row').each(function() {
                const start = $(this).find('input').eq(0).val().trim();
                const end = $(this).find('input').eq(1).val().trim();
                if (start && end) {
                    newRules.push({ start, end });
                }
            });
            extension_settings[extensionName].historiographyExclusionRules = newRules;
            saveSettings();
            toastr.success('内容排除规则已保存。', '圣旨已达');
        },
        onShow: (dialogElement) => {
            const rulesList = dialogElement.find('#historiography-rules-list');

            dialogElement.find('#historiography-add-rule-btn').on('click', () => {
                const newIndex = rulesList.children().length;
                const newRowHtml = createRuleRowHtml({ start: '', end: '' }, newIndex);
                rulesList.append(newRowHtml);
            });

            rulesList.on('click', '.hly-delete-rule-btn', function() {
                $(this).closest('.hly-exclusion-rule-row').remove();
            });
        }
    });
}
