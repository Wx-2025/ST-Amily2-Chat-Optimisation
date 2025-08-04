import { extension_settings } from "/scripts/extensions.js";
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
  executeExpedition, stopExpedition // 【新】停战钦差已就位！
} from "../core/historiographer.js";


// 一个辅助函数，用于处理两个谕旨编辑器的通用逻辑
function setupPromptEditor(type) {
  const selector = document.getElementById(
    `amily2_mhb_${type}_prompt_selector`,
  );
  const editor = document.getElementById(`amily2_mhb_${type}_editor`);
  const saveBtn = document.getElementById(`amily2_mhb_${type}_save_button`);
  const restoreBtn = document.getElementById(
    `amily2_mhb_${type}_restore_button`,
  );

  // 我们需要从主设置对象中读取这些真实、隐藏的提示词
  const jailbreakKey =
    type === "small"
      ? "historiographySmallJailbreakPrompt"
      : "historiographyLargeJailbreakPrompt";
  const mainPromptKey =
    type === "small"
      ? "historiographySmallSummaryPrompt"
      : "historiographyLargeRefinePrompt";

  // 更新编辑器内容以匹配选择
  const updateEditorView = () => {
    const selected = selector.value;
    if (selected === "jailbreak") {
      editor.value = extension_settings[extensionName][jailbreakKey];
    } else {
      editor.value = extension_settings[extensionName][mainPromptKey];
    }
  };

  // 事件监听
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

  // 初始化视图
      updateEditorView();

//=======【从这里开始新增】=======

    // 【最终圣谕：为“展开谕旨”按钮注入灵魂】
    const expandBtn = document.getElementById(`amily2_mhb_${type}_expand_editor`);

    expandBtn.addEventListener('click', () => {
        const selectedValue = selector.value;
        const selectedText = selector.options[selector.selectedIndex].text; // 获取"破限谕旨"或"敕史纲要"
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
            // 1. 将新内容更新回我们小小的编辑器
            editor.value = newContent;

            // 2.【核心】调用我们已有的保存逻辑，将改动真正写入帝国法典
            if (selectedValue === "jailbreak") {
                extension_settings[extensionName][jailbreakKey] = newContent;
            } else {
                extension_settings[extensionName][mainPromptKey] = newContent;
            }
            if (saveSettings()) {
                toastr.success(`${type === 'small' ? '微言录' : '宏史卷'}的${selectedText}已镌刻！`);
            }

            // 3. 关闭这个弹出窗口
            closeDialog();
        });

        dialogElement.find('.popup-button-cancel').on('click', closeDialog);
        dialogElement[0].showModal();
    });

}

// 帝国【敕史局工部】的主体
// 帝国【敕史局工部】的主体 (已全面升级)
export function bindHistoriographyEvents() {
    console.log("[Amily2号-工部] 【敕史局】的专属工匠已就位...");

    setupPromptEditor("small");
    setupPromptEditor("large");

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
            // 如果输入无效，则从默认设置中恢复，而不是硬编码
            event.target.value = defaultSettings.historiographySmallTriggerThreshold;
            toastr.warning("远征阈值必须是大于0的数字。已重置。", "圣谕有误");
            return; // 阻止保存无效值
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

    // 初始化加载设置
    smallAutoEnable.checked = extension_settings[extensionName].historiographySmallAutoEnable ?? false;
    smallTriggerThreshold.value = extension_settings[extensionName].historiographySmallTriggerThreshold ?? 30;
    writeToLorebook.checked = extension_settings[extensionName].historiographyWriteToLorebook ?? true;
    ingestToRag.checked = extension_settings[extensionName].historiographyIngestToRag ?? false;

    // 【新增】为“交互式巡录”开关注入灵魂
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

    // 加载设置
    tagExtractionToggle.checked = extension_settings[extensionName].historiographyTagExtractionEnabled ?? false;
    tagInput.value = extension_settings[extensionName].historiographyTags ?? '';
    tagInputContainer.style.display = tagExtractionToggle.checked ? 'block' : 'none';

    // 绑定事件
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


    // ========== ⚔️ 远征指挥台 (Expedition Command) 绑定 (核心升级区) ==========
    const expeditionExecuteBtn = document.getElementById("amily2_mhb_small_expedition_execute");

    // 【新】百变神兵：一个专门负责更新指挥按钮状态的函数
    const updateExpeditionButtonUI = (state) => {
        expeditionExecuteBtn.dataset.state = state; // 将当前状态记录在按钮上
        switch (state) {
            case 'running':
                expeditionExecuteBtn.innerHTML = '<i class="fas fa-stop-circle"></i> 停止远征';
                expeditionExecuteBtn.className = 'menu_button small_button interactable danger'; // 更换为“危险”的红色战旗
                break;
            case 'paused':
                expeditionExecuteBtn.innerHTML = '<i class="fas fa-play-circle"></i> 继续远征';
                expeditionExecuteBtn.className = 'menu_button small_button interactable success'; // 更换为“希望”的绿色战旗
                break;
            case 'idle':
            default:
                expeditionExecuteBtn.innerHTML = '<i class="fas fa-flag-checkered"></i> 开始远征';
                expeditionExecuteBtn.className = 'menu_button small_button interactable'; // 恢复默认战旗 (紫色)
                break;
        }
    };

    // 【新】顺风之耳：监听来自【大史官】的帝国广播，实时更新UI
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

    // 【新】智能核心：指挥按钮现在拥有了判断战局的能力
    expeditionExecuteBtn.addEventListener("click", () => {
        const currentState = expeditionExecuteBtn.dataset.state || 'idle';
        if (currentState === 'running') {
            stopExpedition(); // 如果正在打仗，就派钦差去叫停
        } else {
            executeExpedition(); // 否则，就命令战争大臣开战或继续
        }
    });

    // 【初始仪仗】确保每次进入殿堂时，按钮都处于正确的“开始远征”状态
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
      // 自动触发一次change来加载第一个世界书的条目
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
    // 调用未来的【大史官】执行精炼任务
    executeRefinement(worldbook, loreKey);
  });
}


/**
 * 【新增】显示和编辑史官内容排除规则的弹窗
 */
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
        }
    });

    const modalContent = document.getElementById('historiography-exclusion-rules-container');
    const rulesList = modalContent.querySelector('#historiography-rules-list');

    modalContent.querySelector('#historiography-add-rule-btn').addEventListener('click', () => {
        const newIndex = rulesList.children.length;
        const newRowHtml = createRuleRowHtml({ start: '', end: '' }, newIndex);
        rulesList.insertAdjacentHTML('beforeend', newRowHtml);
    });

    rulesList.addEventListener('click', (event) => {
        if (event.target.classList.contains('hly-delete-rule-btn')) {
            event.target.closest('.hly-exclusion-rule-row').remove();
        }
    });
}
