import { extension_settings, getContext } from "/scripts/extensions.js";
import { eventSource, event_types } from "/script.js";
import { loadWorldInfo, world_names } from "/scripts/world-info.js";
import {
  extensionName,
  defaultSettings,
  saveSettings,
} from "../utils/settings.js";
import { showHtmlModal } from './page-window.js';
import { configManager } from '../utils/config/ConfigManager.js';
import { ruleProfileManager, resolveHistoriographyRuleConfig } from '../utils/config/RuleProfileManager.js';
import { clearSecretInput, markSecretInputStored, readSecretInputUpdate } from './secret-input.js';
import {
  normalizeRefinementLimits,
  REFINEMENT_INPUT_RESERVE_TOKENS,
} from '../core/historiography-ledger.js';

import {
  getAvailableWorldbooks, getLoresForWorldbook,
  executeManualSummary, executeRefinement, executeActiveLedgerRefinement,
  executeExpedition, stopExpedition,
  archiveCurrentLedger, getArchivedLedgers, restoreArchivedLedger,
  getHistoriographyLedgerStatus, previewActiveLedgerMigration,
  executeActiveLedgerMigration, rollbackActiveSegmentedLedger,
  retryActiveSegmentVectors,
  diagnoseActiveHistoriographyLedger,
  repairActiveHistoriographyLedger,
} from "../core/historiographer.js";
import {
  HISTORIOGRAPHY_PROTOCOL_LEGACY,
  HISTORIOGRAPHY_PROTOCOL_SEGMENTED,
  MAX_SEGMENT_MAX_BLOCKS,
  MIN_SEGMENT_MAX_BLOCKS,
} from '../core/historiography/constants.js';
import {
  resolveHistoriographyPromptKeys,
} from '../core/historiography/prompt-profiles.js';
import {
  initializeHistoriographyEditorProtection,
} from '../core/historiography/editor-protection.js';

import { testNgmsApiConnection, fetchNgmsModels } from "../core/api/Ngms_api.js";

function getHistoriographyRuleConfig() {
  return resolveHistoriographyRuleConfig(extension_settings[extensionName] || {});
}

function _escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _downloadHistoriographyDiagnostic(report) {
  const blob = new Blob([JSON.stringify(report, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = `amily2-historiography-diagnostic-${Date.now()}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}

function _populateHistRuleProfileSelect(select, detail) {
  const profiles = detail?.profiles ?? ruleProfileManager.listProfiles();
  const assigned = detail?.assignments?.historiography ?? ruleProfileManager.getAssignment('historiography') ?? '';
  select.innerHTML = [
    '<option value="">— 未分配 —</option>',
    ...profiles.map(p =>
      `<option value="${p.id}" ${p.id === assigned ? 'selected' : ''}>${_escapeHtml(p.name || p.id)}</option>`
    ),
  ].join('');
}


function setupPromptEditor(type) {
  const selector = document.getElementById(
    `amily2_mhb_${type}_prompt_selector`,
  );
  const editor = document.getElementById(`amily2_mhb_${type}_editor`);
  const saveBtn = document.getElementById(`amily2_mhb_${type}_save_button`);
  const restoreBtn = document.getElementById(
    `amily2_mhb_${type}_restore_button`,
  );
  const protocolSelector = document.getElementById(
    'historiography_prompt_protocol_selector',
  );

  const getKeys = () => resolveHistoriographyPromptKeys(
    type,
    protocolSelector?.value || HISTORIOGRAPHY_PROTOCOL_SEGMENTED,
  );

  const updateEditorView = () => {
    const selected = selector.value;
    const keys = getKeys();
    const key = selected === 'jailbreak' ? keys.jailbreak : keys.task;
    editor.value = extension_settings[extensionName][key]
      ?? defaultSettings[key]
      ?? '';
  };

  selector.addEventListener("change", updateEditorView);
  protocolSelector?.addEventListener('change', updateEditorView);

  saveBtn.addEventListener("click", () => {
    const selected = selector.value;
    const keys = getKeys();
    const key = selected === 'jailbreak' ? keys.jailbreak : keys.task;
    extension_settings[extensionName][key] = editor.value;
    if (saveSettings()) {
      toastr.success(
        `${type === "small" ? "微言录" : "宏史卷"}的${selected === "jailbreak" ? "破限谕旨" : "纲要"}已保存！`,
      );
    }
  });

  restoreBtn.addEventListener("click", () => {
    const selected = selector.value;
    const keys = getKeys();
    const key = selected === 'jailbreak' ? keys.jailbreak : keys.task;
    editor.value = defaultSettings[key];
    toastr.info("已恢复为默认谕旨，请点击“保存当前”以确认。");
  });

      updateEditorView();


    const expandBtn = document.getElementById(`amily2_mhb_${type}_expand_editor`);

    expandBtn.addEventListener('click', () => {
        const selectedValue = selector.value;
        const selectedText = selector.options[selector.selectedIndex].text; 
        const selectedKeys = getKeys();
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
            const key = selectedValue === 'jailbreak'
              ? selectedKeys.jailbreak
              : selectedKeys.task;
            extension_settings[extensionName][key] = newContent;
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

    initializeHistoriographyEditorProtection({
      loadBook: loadWorldInfo,
      getSelectedBookName: () => {
        const index = Number.parseInt(
          document.getElementById('world_editor_select')?.value,
          10,
        );
        return Number.isInteger(index) && index >= 0
          ? world_names[index] || null
          : null;
      },
      subscribeWorldInfoUpdated: callback => {
        const handler = (name, data) => callback(name, data);
        eventSource.on(event_types.WORLDINFO_UPDATED, handler);
        return () => {
          if (typeof eventSource.off === 'function') {
            eventSource.off(event_types.WORLDINFO_UPDATED, handler);
          } else if (typeof eventSource.removeListener === 'function') {
            eventSource.removeListener(
              event_types.WORLDINFO_UPDATED,
              handler,
            );
          }
        };
      },
      onBlocked: () => toastr.warning(
        '该条目属于宏史卷内部结构。请使用 Amily 的诊断、迁移或回滚功能处理。',
        '史册只读保护',
      ),
      onError: error => console.warn(
        '[大史官] 原生世界书只读保护刷新失败:',
        error,
      ),
    });

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
            toastr.error("请输入有效的起始和结束楼层。", "总结");
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
            toastr.warning("每次总结层数必须是大于 0 的数字，已重置。", "总结");
            return; 
        }
        extension_settings[extensionName].historiographySmallTriggerThreshold = value;
        saveSettings();
    });

    const retentionCount = document.getElementById("historiography_retention_count");

    retentionCount.addEventListener("change", (event) => {
        const value = parseInt(event.target.value, 10);
        if (isNaN(value) || value < 0) {
            event.target.value = defaultSettings.historiographyRetentionCount;
            toastr.warning("保留层数必须是大于或等于 0 的数字，已重置。", "总结");
            return;
        }
        extension_settings[extensionName].historiographyRetentionCount = value;
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
    retentionCount.value = extension_settings[extensionName].historiographyRetentionCount ?? 5;
    writeToLorebook.checked = extension_settings[extensionName].historiographyWriteToLorebook ?? true;
    ingestToRag.checked = extension_settings[extensionName].historiographyIngestToRag ?? false;

    const autoSummaryInteractive = document.getElementById("historiography_auto_summary_interactive");
    autoSummaryInteractive.checked = extension_settings[extensionName].historiographyAutoSummaryInteractive ?? false;
    autoSummaryInteractive.addEventListener("change", (event) => {
        extension_settings[extensionName].historiographyAutoSummaryInteractive = event.target.checked;
        saveSettings();
    });

    // ========== 提取规则下拉选单 ==========
    const histRuleSelect = document.getElementById("historiography-rule-profile-select");
    if (histRuleSelect) {
        _populateHistRuleProfileSelect(histRuleSelect);
        histRuleSelect.addEventListener("change", () => {
            ruleProfileManager.setAssignment('historiography', histRuleSelect.value || null);
            const name = histRuleSelect.selectedOptions[0]?.textContent || '';
            toastr.info(histRuleSelect.value ? `史官提取规则已切换为「${name}」` : '史官提取规则已取消分配');
        });
        document.addEventListener('amily2:ruleProfilesChanged', (e) => {
            _populateHistRuleProfileSelect(histRuleSelect, e.detail);
        });
    }


    const expeditionExecuteBtn = document.getElementById("amily2_mhb_small_expedition_execute");

    const updateExpeditionButtonUI = (state) => {
        expeditionExecuteBtn.dataset.state = state;
        switch (state) {
            case 'running':
                expeditionExecuteBtn.innerHTML = '<i class="fas fa-stop-circle"></i> 停止补全';
                expeditionExecuteBtn.className = 'menu_button small_button interactable danger';
                break;
            case 'paused':
                expeditionExecuteBtn.innerHTML = '<i class="fas fa-play-circle"></i> 继续补全';
                expeditionExecuteBtn.className = 'menu_button small_button interactable success';
                break;
            case 'idle':
            default:
                expeditionExecuteBtn.innerHTML = '<i class="fas fa-flag-checkered"></i> 开始总结';
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

    // ========== 📚 史册归档与回溯 绑定 ==========
    const archiveCurrentBtn = document.getElementById("amily2_mhb_archive_current");
    const archiveSelector = document.getElementById("amily2_mhb_archive_selector");
    const refreshArchivesBtn = document.getElementById("amily2_mhb_refresh_archives");
    const restoreArchiveBtn = document.getElementById("amily2_mhb_restore_archive");

    const updateArchiveList = async () => {
        archiveSelector.innerHTML = '<option value="">正在翻阅旧档...</option>';
        const archives = await getArchivedLedgers();
        archiveSelector.innerHTML = ""; // 清空
        if (archives && archives.length > 0) {
            archives.forEach((arch) => {
                const option = document.createElement("option");
                option.value = arch.key;
                option.textContent = arch.comment;
                archiveSelector.appendChild(option);
            });
        } else {
            archiveSelector.innerHTML = '<option value="">未发现归档史册</option>';
        }
    };

    archiveCurrentBtn.addEventListener("click", async () => {
        if (confirm("确定要归档当前的【对话流水总帐】并停用它吗？\n这将允许您开始一段全新的历史记录。")) {
            const success = await archiveCurrentLedger();
            if (success) {
                updateArchiveList(); // 归档成功后刷新列表
            }
        }
    });

    refreshArchivesBtn.addEventListener("click", updateArchiveList);

    restoreArchiveBtn.addEventListener("click", async () => {
        const selectedKey = archiveSelector.value;
        if (!selectedKey) {
            toastr.warning("请先选择一个要回溯的条目。", "总结");
            return;
        }
        if (confirm("确定要回溯选中的史册吗？\n当前的活跃史册（如果有）将被自动归档。")) {
            await restoreArchivedLedger(selectedKey);
            updateArchiveList(); // 回溯后刷新列表
        }
    });

    // ========== 分段史册状态、迁移与回滚 ==========
    const preferredProtocolSelect = document.getElementById(
      'historiography_preferred_protocol',
    );
    const ledgerStatusBox = document.getElementById(
      'historiography_ledger_status',
    );
    const refreshLedgerStatusBtn = document.getElementById(
      'historiography_refresh_ledger_status',
    );
    const previewMigrationBtn = document.getElementById(
      'historiography_preview_migration',
    );
    const executeMigrationBtn = document.getElementById(
      'historiography_execute_migration',
    );
    const rollbackSegmentedBtn = document.getElementById(
      'historiography_rollback_segmented',
    );
    const retrySegmentVectorsBtn = document.getElementById(
      'historiography_retry_segment_vectors',
    );
    const exportDiagnosticsBtn = document.getElementById(
      'historiography_export_diagnostics',
    );
    const repairLedgerBtn = document.getElementById(
      'historiography_repair_safe_states',
    );
    let migrationPreviewSnapshot = null;
    let ledgerStatusSnapshot = null;
    let diagnosticSnapshot = null;

    preferredProtocolSelect.value =
      extension_settings[extensionName].historiographyPreferredProtocol
      === HISTORIOGRAPHY_PROTOCOL_LEGACY
        ? HISTORIOGRAPHY_PROTOCOL_LEGACY
        : HISTORIOGRAPHY_PROTOCOL_SEGMENTED;
    preferredProtocolSelect.addEventListener('change', () => {
      extension_settings[extensionName].historiographyPreferredProtocol =
        preferredProtocolSelect.value === HISTORIOGRAPHY_PROTOCOL_LEGACY
          ? HISTORIOGRAPHY_PROTOCOL_LEGACY
          : HISTORIOGRAPHY_PROTOCOL_SEGMENTED;
      saveSettings();
      migrationPreviewSnapshot = null;
      diagnosticSnapshot = null;
      executeMigrationBtn.disabled = true;
      repairLedgerBtn.disabled = true;
    });

    const renderLedgerStatus = status => {
      if (!status.available) {
        const message = status.reason === 'no-target'
          ? '当前聊天没有可用的目标世界书。'
          : `当前没有活动史册；下一次写入将创建 ${
              status.protocol === HISTORIOGRAPHY_PROTOCOL_LEGACY
                ? '滚动史册 v0.1'
                : '分段史册 v1'
            }。`;
        ledgerStatusBox.innerHTML = `<small class="notes">${_escapeHtml(message)}</small>`;
        previewMigrationBtn.disabled = true;
        rollbackSegmentedBtn.disabled = true;
        retrySegmentVectorsBtn.disabled = true;
        archiveCurrentBtn.disabled = false;
        restoreArchiveBtn.disabled = false;
        return;
      }
      if (status.protocol === HISTORIOGRAPHY_PROTOCOL_SEGMENTED) {
        const vectorStates = status.vectorStates || {};
        const verified = vectorStates.verified || 0;
        const retryable = vectorStates.retryable || 0;
        const pending = vectorStates.pending || 0;
        const notRequested = vectorStates['not-requested'] || 0;
        const residency = status.residency || {};
        const residentWarning = residency.fits === false
          ? `<br><span style="color: var(--SmartThemeQuoteColor);">常驻预算超出 ${residency.overBy} Token；其中 ${residency.safetyLoadedTokens || 0} Token 因向量尚未验证而安全保留。</span>`
          : '';
        ledgerStatusBox.innerHTML = `
          <small class="notes">
            <strong>分段史册 v1</strong> · revision ${status.revision}<br>
            已总结至 ${status.lastSummarizedFloor} 楼 · ${status.segmentCount} 个宏史卷分段 · ${status.pendingBlockCount} 个待编纂批次<br>
            向量：${verified} 段已验证 · ${retryable} 段待重试 · ${pending} 段待收讫 · ${notRequested} 段未请求；当前加载 ${status.vectorLoadedCount} 段<br>
            常驻 Token：${residency.totalTokens ?? 0}/${residency.maxTokens ?? '?'}（活动尾部 ${residency.tailTokens ?? 0}，宏史卷 ${residency.segmentTokens ?? 0}）${residentWarning}
          </small>`;
        previewMigrationBtn.disabled = true;
        rollbackSegmentedBtn.disabled = !status.canRollback;
        archiveCurrentBtn.disabled = true;
        restoreArchiveBtn.disabled = true;
        retrySegmentVectorsBtn.disabled = !status.canRetryVectors;
        return;
      }
      ledgerStatusBox.innerHTML = `
        <small class="notes">
          <strong>滚动史册 v0.1</strong><br>
          已总结至 ${status.lastSummarizedFloor} 楼 · 宏史卷至 ${status.compiledFloor} 楼 · ${status.pendingBlockCount} 个待合并批次
        </small>`;
      previewMigrationBtn.disabled = false;
      rollbackSegmentedBtn.disabled = true;
      retrySegmentVectorsBtn.disabled = true;
      archiveCurrentBtn.disabled = false;
      restoreArchiveBtn.disabled = false;
    };

    const refreshLedgerStatus = async () => {
      ledgerStatusBox.innerHTML = '<small class="notes">正在校验活动史册...</small>';
      migrationPreviewSnapshot = null;
      diagnosticSnapshot = null;
      executeMigrationBtn.disabled = true;
      repairLedgerBtn.disabled = true;
      try {
        ledgerStatusSnapshot = await getHistoriographyLedgerStatus();
        renderLedgerStatus(ledgerStatusSnapshot);
      } catch (error) {
        ledgerStatusSnapshot = null;
        ledgerStatusBox.innerHTML = `<small class="notes" style="color: var(--SmartThemeQuoteColor);">校验失败：${_escapeHtml(error.message)}</small>`;
        previewMigrationBtn.disabled = true;
        rollbackSegmentedBtn.disabled = true;
        retrySegmentVectorsBtn.disabled = true;
      }
    };

    refreshLedgerStatusBtn.addEventListener('click', refreshLedgerStatus);
    previewMigrationBtn.addEventListener('click', async () => {
      previewMigrationBtn.disabled = true;
      try {
        const preview = await previewActiveLedgerMigration();
        migrationPreviewSnapshot = preview.migratable ? preview : null;
        executeMigrationBtn.disabled = !preview.migratable;
        const diagnostics = preview.diagnostics.length
          ? preview.diagnostics.map(item =>
              `<li><strong>${_escapeHtml(item.severity)}</strong> · ${_escapeHtml(item.code)}：${_escapeHtml(item.message)}</li>`
            ).join('')
          : '<li>未发现结构问题。</li>';
        showHtmlModal('旧账迁移预览', `
          <div class="historiography-migration-preview">
            <p><strong>${preview.migratable ? '可以迁移' : '已阻止迁移'}</strong></p>
            <p>总进度：${preview.totalFloors} 楼<br>旧宏史卷：1-${preview.compiledFloor} 楼<br>待迁移微言录：${preview.pendingBlockCount} 块</p>
            <ul>${diagnostics}</ul>
            ${preview.macroPreview
              ? `<details><summary>旧宏史卷正文预览</summary><pre style="white-space: pre-wrap; overflow-wrap: anywhere;">${_escapeHtml(preview.macroPreview)}</pre></details>`
              : ''}
          </div>`, {
          okText: '关闭预览',
          showCancel: false,
        });
      } catch (error) {
        migrationPreviewSnapshot = null;
        executeMigrationBtn.disabled = true;
        toastr.error(`迁移预览失败：${error.message}`, '史册迁移');
      } finally {
        previewMigrationBtn.disabled =
          ledgerStatusSnapshot?.protocol
          !== HISTORIOGRAPHY_PROTOCOL_LEGACY;
      }
    });

    executeMigrationBtn.addEventListener('click', async () => {
      if (!migrationPreviewSnapshot) {
        toastr.warning('请先生成一份通过校验的迁移预览。', '史册迁移');
        return;
      }
      if (!confirm(
        '确定将当前旧版史册迁移为分段史册吗？\n'
        + '旧条目会在同一次保存中变成字节级禁用归档，不会删除。',
      )) return;
      executeMigrationBtn.disabled = true;
      try {
        await executeActiveLedgerMigration(migrationPreviewSnapshot);
        toastr.success('旧版史册已迁移为分段史册。', '史册迁移');
        migrationPreviewSnapshot = null;
        await refreshLedgerStatus();
      } catch (error) {
        toastr.error(`迁移失败：${error.message}`, '史册迁移', {
          timeOut: 12000,
        });
      }
    });

    rollbackSegmentedBtn.addEventListener('click', async () => {
      if (!ledgerStatusSnapshot
        || ledgerStatusSnapshot.protocol
          !== HISTORIOGRAPHY_PROTOCOL_SEGMENTED) {
        return;
      }
      if (!confirm(
        '确定回滚为旧版滚动史册吗？\n'
        + '分段条目只会被禁用，不会删除；若迁移后已有新内容，将由程序确定性投影为旧格式。',
      )) return;
      rollbackSegmentedBtn.disabled = true;
      try {
        const result = await rollbackActiveSegmentedLedger(
          ledgerStatusSnapshot,
        );
        toastr.success(
          result.rollbackMode === 'exact-source'
            ? '已恢复迁移前的字节级旧史册正本。'
            : '已将当前分段史册确定性投影为旧格式。',
          '史册回滚',
        );
        await refreshLedgerStatus();
      } catch (error) {
        toastr.error(`回滚失败：${error.message}`, '史册回滚', {
          timeOut: 12000,
        });
        await refreshLedgerStatus();
      }
    });
    retrySegmentVectorsBtn.addEventListener('click', async () => {
      if (!ledgerStatusSnapshot?.canRetryVectors) return;
      retrySegmentVectorsBtn.disabled = true;
      const originalHtml = retrySegmentVectorsBtn.innerHTML;
      try {
        const result = await retryActiveSegmentVectors({
          onProgress: progress => {
            if (progress.phase === 'preparing') {
              retrySegmentVectorsBtn.textContent =
                `检查 ${progress.index}/${progress.total}`;
            } else if (progress.phase === 'delivering') {
              retrySegmentVectorsBtn.textContent =
                `回读 ${progress.index}/${progress.total}`;
            }
          },
        });
        const message = result.failed > 0
          ? `检查完成：${result.verified} 段已重建，${result.skipped} 段无需变更，${result.failed} 段保持加载并待重试。`
          : `检查完成：${result.verified} 段已重建，${result.skipped} 段无需变更。`;
        toastr[result.failed > 0 ? 'warning' : 'success'](
          message,
          '宏史卷向量索引',
          { timeOut: 12000 },
        );
      } catch (error) {
        toastr.error(`向量检查已停止：${error.message}`, '宏史卷向量索引', {
          timeOut: 12000,
        });
      } finally {
        retrySegmentVectorsBtn.innerHTML = originalHtml;
        await refreshLedgerStatus();
      }
    });
    exportDiagnosticsBtn.addEventListener('click', async () => {
      exportDiagnosticsBtn.disabled = true;
      try {
        diagnosticSnapshot = await diagnoseActiveHistoriographyLedger();
        repairLedgerBtn.disabled =
          (diagnosticSnapshot.safeRepairs?.length || 0) === 0;
        _downloadHistoriographyDiagnostic(diagnosticSnapshot);
        const diagnosticItems = diagnosticSnapshot.diagnostics?.length
          ? diagnosticSnapshot.diagnostics.map(item =>
              `<li><strong>${_escapeHtml(item.severity)}</strong> · ${_escapeHtml(item.code)}：${_escapeHtml(item.message)}${item.details?.suggestion ? `<br><small>${_escapeHtml(item.details.suggestion)}</small>` : ''}</li>`
            ).join('')
          : '<li>未发现结构或加载状态问题。</li>';
        const orphanItems = diagnosticSnapshot.orphanEntries?.length
          ? diagnosticSnapshot.orphanEntries.map(item =>
              `<li>${_escapeHtml(item.kind)} · UID ${_escapeHtml(item.entryUid)} · 键 ${_escapeHtml(item.key)}</li>`
            ).join('')
          : '<li>没有检测到孤儿内部条目。</li>';
        showHtmlModal('分段史册诊断', `
          <p><strong>${diagnosticSnapshot.valid ? '校验通过' : '需要处理'}</strong> · ${diagnosticSnapshot.summary.errors} 个错误 · ${diagnosticSnapshot.summary.warnings} 个警告 · ${diagnosticSnapshot.summary.orphans} 个孤儿候选</p>
          <p><small>完整的脱敏 JSON 报告已下载。孤儿条目不会自动删除；只有 disable 加载位可以通过安全修复按钮恢复。</small></p>
          <h4>诊断</h4><ul>${diagnosticItems}</ul>
          <h4>孤儿候选</h4><ul>${orphanItems}</ul>
        `, {
          okText: '关闭',
          showCancel: false,
        });
      } catch (error) {
        diagnosticSnapshot = null;
        repairLedgerBtn.disabled = true;
        toastr.error(`诊断失败：${error.message}`, '分段史册诊断', {
          timeOut: 12000,
        });
      } finally {
        exportDiagnosticsBtn.disabled = false;
      }
    });
    repairLedgerBtn.addEventListener('click', async () => {
      if (!diagnosticSnapshot?.safeRepairs?.length) return;
      if (!confirm(
        `将按刚才的诊断修复 ${diagnosticSnapshot.safeRepairs.length} 个条目的启用/禁用状态。\n`
        + '不会改正文、hash、Manifest 引用或删除孤儿条目。继续吗？',
      )) return;
      repairLedgerBtn.disabled = true;
      try {
        const result = await repairActiveHistoriographyLedger(
          diagnosticSnapshot,
        );
        toastr.success(
          `已修复 ${result?.repaired || 0} 个条目的安全加载状态。`,
          '分段史册恢复',
        );
        diagnosticSnapshot = null;
        await refreshLedgerStatus();
      } catch (error) {
        toastr.error(`安全修复失败：${error.message}`, '分段史册恢复', {
          timeOut: 12000,
        });
      }
    });
    refreshLedgerStatus();

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
  const largeRefineActiveBtn = document.getElementById(
    "amily2_mhb_large_refine_active",
  );

  const bindBoundedRefinementNumber = (id, key, min, max) => {
    const input = document.getElementById(id);
    if (!input) return;
    input.value = extension_settings[extensionName][key] ?? defaultSettings[key];
    input.addEventListener("change", () => {
      const parsed = Number.parseInt(input.value, 10);
      if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        input.value = defaultSettings[key];
        extension_settings[extensionName][key] = defaultSettings[key];
        saveSettings();
        toastr.warning(
          `数值需在 ${min}-${max} 之间，已恢复默认值 ${defaultSettings[key]}。`,
          "宏史卷设置",
        );
        return;
      }
      extension_settings[extensionName][key] = parsed;
      saveSettings();
    });
  };

  bindBoundedRefinementNumber(
    "historiography_refine_reminder_blocks",
    "historiographyRefineReminderBlocks",
    5,
    500,
  );
  bindBoundedRefinementNumber(
    'historiography_segment_max_blocks',
    'historiographySegmentMaxBlocks',
    MIN_SEGMENT_MAX_BLOCKS,
    MAX_SEGMENT_MAX_BLOCKS,
  );
  bindBoundedRefinementNumber(
    'historiography_vector_retain_recent',
    'historiographyVectorRetainRecent',
    1,
    100,
  );
  bindBoundedRefinementNumber(
    'historiography_resident_max_tokens',
    'historiographyResidentMaxTokens',
    5000,
    256000,
  );

  const inputLimit =
    document.getElementById("historiography_refine_input_max_tokens");
  const activeLimit =
    document.getElementById("historiography_rolling_summary_max_tokens");
  if (inputLimit && activeLimit) {
    const getCurrentSettings = () => extension_settings[extensionName];
    const initialSettings = getCurrentSettings();
    const initialLimits = normalizeRefinementLimits(initialSettings);
    const limitsWereNormalized =
      initialSettings.historiographyRefineInputMaxTokens
        !== initialLimits.inputMaxTokens
      || initialSettings.historiographyRollingSummaryMaxTokens
        !== initialLimits.activeMaxTokens;
    initialSettings.historiographyRefineInputMaxTokens =
      initialLimits.inputMaxTokens;
    initialSettings.historiographyRollingSummaryMaxTokens =
      initialLimits.activeMaxTokens;
    inputLimit.value = initialLimits.inputMaxTokens;
    activeLimit.value = initialLimits.activeMaxTokens;
    if (limitsWereNormalized) saveSettings();

    const persistLimits = (inputTokens, activeTokens, warning) => {
      const settings = getCurrentSettings();
      settings.historiographyRefineInputMaxTokens = inputTokens;
      settings.historiographyRollingSummaryMaxTokens = activeTokens;
      inputLimit.value = inputTokens;
      activeLimit.value = activeTokens;
      saveSettings();
      if (warning) {
        toastr.warning(warning, "宏史卷设置");
      }
    };

    inputLimit.addEventListener("change", () => {
      let inputTokens = Number.parseInt(inputLimit.value, 10);
      let activeTokens = Number.parseInt(activeLimit.value, 10);
      if (!Number.isFinite(inputTokens)
        || inputTokens < 5000
        || inputTokens > 128000) {
        const normalized = normalizeRefinementLimits(getCurrentSettings());
        persistLimits(
          normalized.inputMaxTokens,
          normalized.activeMaxTokens,
          "输入上限需在 5000-128000 之间，已恢复到安全值。",
        );
        return;
      }
      if (!Number.isFinite(activeTokens)) {
        activeTokens = defaultSettings.historiographyRollingSummaryMaxTokens;
      }
      if (activeTokens + REFINEMENT_INPUT_RESERVE_TOKENS > inputTokens) {
        activeTokens = Math.max(
          1000,
          inputTokens - REFINEMENT_INPUT_RESERVE_TOKENS,
        );
        if (activeTokens + REFINEMENT_INPUT_RESERVE_TOKENS > inputTokens) {
          inputTokens =
            activeTokens + REFINEMENT_INPUT_RESERVE_TOKENS;
        }
        persistLimits(
          inputTokens,
          activeTokens,
          `输入上限必须比活动宏史卷至少多 `
            + `${REFINEMENT_INPUT_RESERVE_TOKENS} Token，`
            + `已同步调整活动宏史卷上限为 ${activeTokens}。`,
        );
        return;
      }
      persistLimits(inputTokens, activeTokens);
    });

    activeLimit.addEventListener("change", () => {
      let activeTokens = Number.parseInt(activeLimit.value, 10);
      let inputTokens = Number.parseInt(inputLimit.value, 10);
      if (!Number.isFinite(activeTokens)
        || activeTokens < 1000
        || activeTokens > 32000) {
        const normalized = normalizeRefinementLimits(getCurrentSettings());
        persistLimits(
          normalized.inputMaxTokens,
          normalized.activeMaxTokens,
          "活动宏史卷上限需在 1000-32000 之间，已恢复到安全值。",
        );
        return;
      }
      if (!Number.isFinite(inputTokens)) {
        inputTokens = defaultSettings.historiographyRefineInputMaxTokens;
      }
      if (activeTokens + REFINEMENT_INPUT_RESERVE_TOKENS > inputTokens) {
        inputTokens =
          activeTokens + REFINEMENT_INPUT_RESERVE_TOKENS;
        persistLimits(
          inputTokens,
          activeTokens,
          `为给固定提示和微言录保留 `
            + `${REFINEMENT_INPUT_RESERVE_TOKENS} Token，`
            + `已同步提高输入上限为 ${inputTokens}。`,
        );
        return;
      }
      persistLimits(inputTokens, activeTokens);
    });
  }

  largeRefineActiveBtn?.addEventListener("click", () => {
    executeActiveLedgerRefinement();
  });

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
      toastr.error("请先选择世界书和其中的条目。", "总结");
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
    const ngmsFakeStreamToggle = document.getElementById('amily2_ngms_fakestream_enabled');
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

    if (ngmsFakeStreamToggle) {
        ngmsFakeStreamToggle.checked = extension_settings[extensionName].ngmsFakeStreamEnabled ?? false;
        ngmsFakeStreamToggle.addEventListener('change', function() {
            updateAndSaveSetting('ngmsFakeStreamEnabled', this.checked);
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
        { id: 'amily2_ngms_api_key', key: 'ngmsApiKey', sensitive: true },
        { id: 'amily2_ngms_model', key: 'ngmsModel' }
    ];

    apiFields.forEach(field => {
        const element = document.getElementById(field.id);
        if (element) {
            if (field.sensitive) {
                clearSecretInput(element, configManager.has(field.key));
            } else {
                element.value = extension_settings[extensionName][field.key] || '';
            }
            element.addEventListener('change', function() {
                if (field.sensitive) {
                    const update = readSecretInputUpdate(this);
                    if (!update.changed) return;
                    configManager.set(field.key, update.value);
                    markSecretInputStored(this, Boolean(update.value));
                } else {
                    updateAndSaveSetting(field.key, this.value);
                }
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

