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
  getActiveLedgerSafeEditSnapshot,
  applyActiveLedgerSafeEdit,
} from "../core/historiographer.js";
import {
  HISTORIOGRAPHY_PROTOCOL_LEGACY,
  HISTORIOGRAPHY_PROTOCOL_SEGMENTED,
  MAX_SEGMENT_MAX_BLOCKS,
  MIN_SEGMENT_MAX_BLOCKS,
} from '../core/historiography/constants.js';
import {
  resolveHistoriographyPromptProtocol,
  resolveHistoriographyPromptKeys,
} from '../core/historiography/prompt-profiles.js';
import {
  initializeHistoriographyEditorProtection,
} from '../core/historiography/editor-protection.js';
import { subscribeLocaleChange, t } from '../utils/i18n/index.js';

import { testNgmsApiConnection, fetchNgmsModels } from "../core/api/Ngms_api.js";

function getHistoriographyRuleConfig() {
  return resolveHistoriographyRuleConfig(extension_settings[extensionName] || {});
}

function _escapeHtml(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let unsubscribeLedgerLocale = () => {};
let unsubscribeLedgerStatus = () => {};

function buildLedgerStatusHtml(status) {
  if (!status.available) {
    const message = status.reason === 'no-target'
      ? t('summaryWorkflow.noTarget')
      : t('summaryWorkflow.noLedger', { protocol: t(status.protocol === HISTORIOGRAPHY_PROTOCOL_LEGACY
          ? 'summaryWorkflow.legacy' : 'summaryWorkflow.segmented') });
    return `<small class="notes">${_escapeHtml(message)}</small>`;
  }
  if (status.protocol !== HISTORIOGRAPHY_PROTOCOL_SEGMENTED) {
    return `<small class="notes"><strong>${_escapeHtml(t('summaryWorkflow.legacy'))}</strong><br>${_escapeHtml(t('summary.legacyProgress', {
      floor: status.lastSummarizedFloor,
      compiled: status.compiledFloor,
      pending: status.pendingBlockCount,
    }))}</small>`;
  }
  const vectorStates = status.vectorStates || {};
  const residency = status.residency || {};
  const residentWarning = residency.fits === false
    ? `<br><span style="color: var(--SmartThemeQuoteColor);">${_escapeHtml(t('summaryWorkflow.residentWarning', { over: residency.overBy, retained: residency.safetyLoadedTokens || 0 }))}</span>`
    : '';
  return `<small class="notes">
    <strong>${_escapeHtml(t('summaryWorkflow.segmented'))}</strong> · revision ${_escapeHtml(status.revision)}<br>
    ${_escapeHtml(t('summary.segmentedProgress', {
      floor: status.lastSummarizedFloor,
      segments: status.segmentCount,
      pending: status.pendingBlockCount,
    }))}<br>
    ${_escapeHtml(t('summaryWorkflow.vectorStatus', { verified: vectorStates.verified || 0, retryable: vectorStates.retryable || 0, pending: vectorStates.pending || 0, unrequested: vectorStates['not-requested'] || 0, loaded: status.vectorLoadedCount }))}<br>
    ${_escapeHtml(t('summary.residentTokens', {
      total: residency.totalTokens ?? 0,
      max: residency.maxTokens ?? '?',
      tail: residency.tailTokens ?? 0,
      segments: residency.segmentTokens ?? 0,
    }))}${residentWarning}
  </small>`;
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
    `<option value="" data-amily-i18n="summaryWorkflow.unassigned">${_escapeHtml(t('summaryWorkflow.unassigned'))}</option>`,
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
        t('summary.promptSaved', {
          summary: t(type === 'small' ? 'summary.small' : 'summary.large'),
          prompt: t(selected === 'jailbreak' ? 'summary.primaryPrompt' : 'summary.taskPrompt'),
        }),
      );
    }
  });

  restoreBtn.addEventListener("click", () => {
    const selected = selector.value;
    const keys = getKeys();
    const key = selected === 'jailbreak' ? keys.jailbreak : keys.task;
    editor.value = defaultSettings[key];
    toastr.info(t('summary.promptRestored'));
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
                <h4 style="margin-top:0; color: #eee; border-bottom: 1px solid rgba(255,255,255,0.2); padding-bottom: 10px;">${_escapeHtml(t('summary.editing', { item: selectedText }))}</h4>
                <div class="popup-content" style="height: 70vh;"><div class="height100p wide100p flex-container"><textarea class="height100p wide100p maximized_textarea text_pole"></textarea></div></div>
                <div class="popup-controls"><div class="popup-button-ok menu_button menu_button_primary interactable">${_escapeHtml(t('actions.saveAndClose'))}</div><div class="popup-button-cancel menu_button interactable" style="margin-left: 10px;">${_escapeHtml(t('actions.cancel'))}</div></div>
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
                toastr.success(t('summary.promptSavedFromDialog', {
                  summary: t(type === 'small' ? 'summary.small' : 'summary.large'),
                  prompt: t(selectedValue === 'jailbreak' ? 'summary.primaryPrompt' : 'summary.taskPrompt'),
                }));
            }
            closeDialog();
        });

        dialogElement.find('.popup-button-cancel').on('click', closeDialog);
        dialogElement[0].showModal();
    });

}

function createLedgerStatusRefresh({ load, scope, connected, loading, render, failed }) {
    let revision = 0;
    let disposed = false;
    return {
        async refresh() {
            if (disposed || !connected()) return;
            const ticket = ++revision;
            const identity = scope();
            const current = () => {
                if (disposed || ticket !== revision || !connected()) return false;
                const active = scope();
                return identity.length === active.length
                    && identity.every((value, index) => value === active[index]);
            };
            loading();
            try {
                const status = await load();
                if (current()) render(status);
            } catch (error) {
                if (current()) failed(error);
            }
        },
        dispose() { disposed = true; revision++; },
    };
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
        t('summary.structureProtected'),
        t('summaryWorkflow.readOnly'),
      ),
      onError: error => console.warn(
        '[大史官] 原生世界书只读保护刷新失败:',
        error,
      ),
    });

    const promptProtocolSelector = document.getElementById(
      'historiography_prompt_protocol_selector',
    );
    promptProtocolSelector.value = resolveHistoriographyPromptProtocol(
      extension_settings[extensionName],
    );
    promptProtocolSelector.addEventListener('change', () => {
      extension_settings[extensionName].historiographyPromptProtocol =
        promptProtocolSelector.value === HISTORIOGRAPHY_PROTOCOL_LEGACY
          ? HISTORIOGRAPHY_PROTOCOL_LEGACY
          : HISTORIOGRAPHY_PROTOCOL_SEGMENTED;
      if (saveSettings()) {
        toastr.success(
          promptProtocolSelector.value === HISTORIOGRAPHY_PROTOCOL_LEGACY
            ? t('summaryWorkflow.useLegacyPrompt')
            : t('summaryWorkflow.useV1Prompt'),
          t('summaryWorkflow.promptSwitched'),
        );
      }
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
            toastr.error(t('summaryWorkflow.invalidRange'), t('summaryWorkflow.summary'));
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
            toastr.warning(t('summaryWorkflow.invalidBatchSize'), t('summaryWorkflow.summary'));
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
            toastr.warning(t('summaryWorkflow.invalidRetention'), t('summaryWorkflow.summary'));
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
            toastr.info(histRuleSelect.value ? _escapeHtml(t('summaryWorkflow.ruleChanged', { name })) : t('summaryWorkflow.ruleCleared'));
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
                expeditionExecuteBtn.innerHTML = `<i class="fas fa-stop-circle"></i> <span data-amily-i18n="summaryWorkflow.stop">${_escapeHtml(t('summaryWorkflow.stop'))}</span>`;
                expeditionExecuteBtn.className = 'menu_button small_button interactable danger';
                break;
            case 'paused':
                expeditionExecuteBtn.innerHTML = `<i class="fas fa-play-circle"></i> <span data-amily-i18n="summaryWorkflow.resume">${_escapeHtml(t('summaryWorkflow.resume'))}</span>`;
                expeditionExecuteBtn.className = 'menu_button small_button interactable success';
                break;
            case 'idle':
            default:
                expeditionExecuteBtn.innerHTML = `<i class="fas fa-flag-checkered"></i> <span data-amily-i18n="summaryWorkflow.start">${_escapeHtml(t('summaryWorkflow.start'))}</span>`;
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
        archiveSelector.innerHTML = `<option value="" data-amily-i18n="summaryWorkflow.loadingArchives">${_escapeHtml(t('summaryWorkflow.loadingArchives'))}</option>`;
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
            archiveSelector.innerHTML = `<option value="" data-amily-i18n="summaryWorkflow.noArchives">${_escapeHtml(t('summaryWorkflow.noArchives'))}</option>`;
        }
    };

    archiveCurrentBtn.addEventListener("click", async () => {
        if (confirm(t('summaryWorkflow.confirmArchive'))) {
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
            toastr.warning(t('summaryWorkflow.selectArchive'), t('summaryWorkflow.summary'));
            return;
        }
        if (confirm(t('summaryWorkflow.confirmRestore'))) {
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
    const safeEditBtn = document.getElementById(
      'historiography_safe_edit',
    );
    let migrationPreviewSnapshot = null;
    let ledgerStatusSnapshot = null;
    let diagnosticSnapshot = null;
    const canSafelyEditLedger = status => status?.protocol
      === HISTORIOGRAPHY_PROTOCOL_SEGMENTED
      && (Number(status.segmentCount || 0)
        + Number(status.pendingBlockCount || 0)) > 0;

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
      safeEditBtn.disabled = true;
    });

    const renderLedgerStatus = status => {
      ledgerStatusBox.innerHTML = buildLedgerStatusHtml(status);
      if (!status.available) {
        previewMigrationBtn.disabled = true;
        rollbackSegmentedBtn.disabled = true;
        retrySegmentVectorsBtn.disabled = true;
        safeEditBtn.disabled = true;
        archiveCurrentBtn.disabled = false;
        restoreArchiveBtn.disabled = false;
        return;
      }
      if (status.protocol === HISTORIOGRAPHY_PROTOCOL_SEGMENTED) {
        previewMigrationBtn.disabled = true;
        rollbackSegmentedBtn.disabled = !status.canRollback;
        archiveCurrentBtn.disabled = true;
        restoreArchiveBtn.disabled = true;
        retrySegmentVectorsBtn.disabled = !status.canRetryVectors;
        safeEditBtn.disabled = !canSafelyEditLedger(status);
        return;
      }
      previewMigrationBtn.disabled = false;
      rollbackSegmentedBtn.disabled = true;
      retrySegmentVectorsBtn.disabled = true;
      safeEditBtn.disabled = true;
      archiveCurrentBtn.disabled = false;
      restoreArchiveBtn.disabled = false;
    };

    unsubscribeLedgerLocale();
    unsubscribeLedgerLocale = subscribeLocaleChange(() => {
      // A language switch must not change in-flight operation controls.
      if (ledgerStatusSnapshot && ledgerStatusBox.isConnected) {
        ledgerStatusBox.innerHTML = buildLedgerStatusHtml(ledgerStatusSnapshot);
      }
    });

    unsubscribeLedgerStatus();
    const statusRefresh = createLedgerStatusRefresh({
      load: getHistoriographyLedgerStatus,
      scope: () => {
        const context = getContext();
        return [context.chat, context.characterId, context.groupId,
          context.getCurrentChatId?.(),
          extension_settings[extensionName]?.lorebookTarget];
      },
      connected: () => ledgerStatusBox.isConnected,
      loading: () => {
        ledgerStatusSnapshot = null;
        ledgerStatusBox.innerHTML = `<small class="notes" data-amily-i18n="summaryWorkflow.validating">${_escapeHtml(t('summaryWorkflow.validating'))}</small>`;
        migrationPreviewSnapshot = null;
        diagnosticSnapshot = null;
        previewMigrationBtn.disabled = true;
        rollbackSegmentedBtn.disabled = true;
        retrySegmentVectorsBtn.disabled = true;
        executeMigrationBtn.disabled = true;
        repairLedgerBtn.disabled = true;
        safeEditBtn.disabled = true;
      },
      render: status => {
        ledgerStatusSnapshot = status;
        renderLedgerStatus(ledgerStatusSnapshot);
      },
      failed: error => {
        ledgerStatusSnapshot = null;
        ledgerStatusBox.innerHTML = `<small class="notes" style="color: var(--SmartThemeQuoteColor);">${_escapeHtml(t('summaryWorkflow.validationFailed', { error: error.message }))}<br>${_escapeHtml(t('summaryWorkflow.validationAdvice'))}</small>`;
        previewMigrationBtn.disabled = true;
        rollbackSegmentedBtn.disabled = true;
        retrySegmentVectorsBtn.disabled = true;
        safeEditBtn.disabled = true;
      },
    });
    const refreshLedgerStatus = () => statusRefresh.refresh();
    const refreshOnEvent = () => { void refreshLedgerStatus(); };
    const hostEvents = [event_types.CHAT_CHANGED, event_types.WORLDINFO_UPDATED]
      .filter(Boolean);
    hostEvents.forEach(type => eventSource.on(type, refreshOnEvent));
    const refreshOnOpen = event => {
      if (event.target?.closest?.('#amily2_open_text_optimization, #amily2_open_additional_features')) {
        refreshOnEvent();
      }
    };
    const refreshOnTarget = event => {
      if (event.target?.name === 'amily2_lorebook_target') refreshOnEvent();
    };
    document.addEventListener('amily-lorebook-created', refreshOnEvent);
    document.addEventListener('click', refreshOnOpen);
    document.addEventListener('change', refreshOnTarget);
    unsubscribeLedgerStatus = () => {
      statusRefresh.dispose();
      for (const type of hostEvents) {
        if (typeof eventSource.off === 'function') eventSource.off(type, refreshOnEvent);
        else eventSource.removeListener?.(type, refreshOnEvent);
      }
      document.removeEventListener('amily-lorebook-created', refreshOnEvent);
      document.removeEventListener('click', refreshOnOpen);
      document.removeEventListener('change', refreshOnTarget);
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
          : `<li>${_escapeHtml(t('summaryWorkflow.noStructureIssues'))}</li>`;
        showHtmlModal(t('summaryWorkflow.migrationPreview'), `
          <div class="historiography-migration-preview">
            <p><strong>${_escapeHtml(t(preview.migratable ? 'summaryWorkflow.migrationAllowed' : 'summaryWorkflow.migrationBlocked'))}</strong></p>
            <p>${_escapeHtml(t('summary.migrationTotal', { floor: preview.totalFloors }))}<br>${_escapeHtml(t('summary.migrationLarge', { floor: preview.compiledFloor }))}<br>${_escapeHtml(t('summary.migrationSmall', { count: preview.pendingBlockCount }))}</p>
            <ul>${diagnostics}</ul>
            ${preview.macroPreview
              ? `<details><summary>${_escapeHtml(t('summary.migrationPreview'))}</summary><pre style="white-space: pre-wrap; overflow-wrap: anywhere;">${_escapeHtml(preview.macroPreview)}</pre></details>`
              : ''}
          </div>`, {
          okText: t('summaryWorkflow.closePreview'),
          showCancel: false,
        });
      } catch (error) {
        migrationPreviewSnapshot = null;
        executeMigrationBtn.disabled = true;
        toastr.error(_escapeHtml(t('summaryWorkflow.previewFailed', { error: error.message })), t('summaryWorkflow.migration'));
      } finally {
        previewMigrationBtn.disabled =
          ledgerStatusSnapshot?.protocol
          !== HISTORIOGRAPHY_PROTOCOL_LEGACY;
      }
    });

    executeMigrationBtn.addEventListener('click', async () => {
      if (!migrationPreviewSnapshot) {
        toastr.warning(t('summaryWorkflow.previewRequired'), t('summaryWorkflow.migration'));
        return;
      }
      if (!confirm(
        t('summaryWorkflow.confirmMigration'),
      )) return;
      executeMigrationBtn.disabled = true;
      try {
        await executeActiveLedgerMigration(migrationPreviewSnapshot);
        toastr.success(t('summaryWorkflow.migrated'), t('summaryWorkflow.migration'));
        migrationPreviewSnapshot = null;
        await refreshLedgerStatus();
      } catch (error) {
        toastr.error(_escapeHtml(t('summaryWorkflow.migrationFailed', { error: error.message })), t('summaryWorkflow.migration'), {
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
        t('summaryWorkflow.confirmRollback'),
      )) return;
      rollbackSegmentedBtn.disabled = true;
      try {
        const result = await rollbackActiveSegmentedLedger(
          ledgerStatusSnapshot,
        );
        toastr.success(
          result.rollbackMode === 'exact-source'
            ? t('summaryWorkflow.rollbackExact')
            : t('summaryWorkflow.rollbackProjected'),
          t('summaryWorkflow.rollback'),
        );
        await refreshLedgerStatus();
      } catch (error) {
        toastr.error(_escapeHtml(t('summaryWorkflow.rollbackFailed', { error: error.message })), t('summaryWorkflow.rollback'), {
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
                t('summaryWorkflow.checkProgress', { index: progress.index, total: progress.total });
            } else if (progress.phase === 'delivering') {
              retrySegmentVectorsBtn.textContent =
                t('summaryWorkflow.readbackProgress', { index: progress.index, total: progress.total });
            }
          },
        });
        const message = result.failed > 0
          ? t('summaryWorkflow.vectorPartial', result)
          : t('summaryWorkflow.vectorComplete', result);
        toastr[result.failed > 0 ? 'warning' : 'success'](
          message,
          t('summary.vectorIndex'),
          { timeOut: 12000 },
        );
      } catch (error) {
        toastr.error(_escapeHtml(t('summaryWorkflow.vectorStopped', { error: error.message })), t('summary.vectorIndex'), {
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
          : `<li>${_escapeHtml(t('summaryWorkflow.noStateIssues'))}</li>`;
        const orphanItems = diagnosticSnapshot.orphanEntries?.length
          ? diagnosticSnapshot.orphanEntries.map(item =>
              `<li>${_escapeHtml(t('summaryWorkflow.orphanEntry', { kind: item.kind, uid: item.entryUid, key: item.key }))}</li>`
            ).join('')
          : `<li>${_escapeHtml(t('summaryWorkflow.noOrphans'))}</li>`;
        const tailIntegrity = diagnosticSnapshot.tailIntegrity;
        let tailIntegrityHtml = `<p><small>${_escapeHtml(t('summary.noTail'))}</small></p>`;
        if (tailIntegrity?.available) {
          const conclusion = tailIntegrity.contentHashMatches
            ? t('summaryWorkflow.hashMatches')
            : tailIntegrity.hashOnlyMismatchCandidate
              ? t('summaryWorkflow.hashCandidate')
              : tailIntegrity.structureValid
                ? t('summaryWorkflow.tailExtraBytes')
                : t('summaryWorkflow.tailInvalid', { code: tailIntegrity.failureCode || 'unknown' });
          tailIntegrityHtml = `
            <p><small>${_escapeHtml(conclusion)}</small></p>
            <ul>
              <li>${_escapeHtml(t('summaryWorkflow.tailMarker', { result: t(tailIntegrity.markerMatches ? 'summaryWorkflow.matches' : 'summaryWorkflow.mismatch') }))}</li>
              <li>${_escapeHtml(t('summaryWorkflow.batchesVerified', { verified: tailIntegrity.verifiedBatchCount, total: tailIntegrity.batchCount }))}</li>
              <li>${_escapeHtml(t('summaryWorkflow.canonicalBytes', { result: t(tailIntegrity.canonicalContentMatches ? 'summaryWorkflow.matches' : 'summaryWorkflow.mismatch') }))}</li>
            </ul>`;
        }
        showHtmlModal(t('summaryWorkflow.diagnosticTitle'), `
          <p><strong>${_escapeHtml(t(diagnosticSnapshot.valid ? 'summaryWorkflow.valid' : 'summaryWorkflow.needsAttention'))}</strong> · ${_escapeHtml(t('summaryWorkflow.diagnosticCounts', diagnosticSnapshot.summary))}</p>
          <p><small>${_escapeHtml(t('summaryWorkflow.diagnosticDownloaded'))}</small></p>
          <h4>${_escapeHtml(t('summaryWorkflow.diagnostics'))}</h4><ul>${diagnosticItems}</ul>
          <h4>${_escapeHtml(t('summaryWorkflow.tailIntegrity'))}</h4>${tailIntegrityHtml}
          <h4>${_escapeHtml(t('summaryWorkflow.orphans'))}</h4><ul>${orphanItems}</ul>
        `, {
          okText: t('summaryWorkflow.close'),
          showCancel: false,
        });
      } catch (error) {
        diagnosticSnapshot = null;
        repairLedgerBtn.disabled = true;
        toastr.error(_escapeHtml(t('summaryWorkflow.diagnosticFailed', { error: error.message })), t('summaryWorkflow.diagnosticTitle'), {
          timeOut: 12000,
        });
      } finally {
        exportDiagnosticsBtn.disabled = false;
      }
    });
    repairLedgerBtn.addEventListener('click', async () => {
      if (!diagnosticSnapshot?.safeRepairs?.length) return;
      if (!confirm(
        t('summaryWorkflow.confirmRepair', { count: diagnosticSnapshot.safeRepairs.length }),
      )) return;
      repairLedgerBtn.disabled = true;
      try {
        const result = await repairActiveHistoriographyLedger(
          diagnosticSnapshot,
        );
        toastr.success(
          t('summaryWorkflow.repaired', { count: result?.repaired || 0 }),
          t('summaryWorkflow.repairTitle'),
        );
        diagnosticSnapshot = null;
        await refreshLedgerStatus();
      } catch (error) {
        toastr.error(_escapeHtml(t('summaryWorkflow.repairFailed', { error: error.message })), t('summaryWorkflow.repairTitle'), {
          timeOut: 12000,
        });
      }
    });
    safeEditBtn.addEventListener('click', async () => {
      safeEditBtn.disabled = true;
      try {
        const snapshot = await getActiveLedgerSafeEditSnapshot();
        if (!snapshot.documents?.length) {
          toastr.info(t('summaryWorkflow.nothingToEdit'), t('summaryWorkflow.safeEdit'));
          return;
        }
        const options = snapshot.documents.map(document => {
          const type = t(document.kind === 'micro-batch'
            ? 'summary.small'
            : 'summary.large');
          return `<option value="${_escapeHtml(document.editId)}">${_escapeHtml(t('summaryWorkflow.editOption', { type, start: document.startFloor, end: document.endFloor }))}</option>`;
        }).join('');
        const dialog = showHtmlModal(t('summaryWorkflow.safeEdit'), `
          <div class="amily2-historiography-safe-edit">
            <label for="amily2_historiography_safe_edit_target" data-amily-i18n="summaryWorkflow.editRange">${_escapeHtml(t('summaryWorkflow.editRange'))}</label>
            <select id="amily2_historiography_safe_edit_target" class="text_pole">${options}</select>
            <div class="amily2-historiography-safe-edit-meta notes" aria-live="polite"></div>
            <label for="amily2_historiography_safe_edit_text" data-amily-i18n="summaryWorkflow.summaryBody">${_escapeHtml(t('summaryWorkflow.summaryBody'))}</label>
            <textarea id="amily2_historiography_safe_edit_text" class="text_pole" spellcheck="false"></textarea>
            <div class="amily2-historiography-safe-edit-notice notes" data-amily-i18n="summary.safeEditNotice">
              ${_escapeHtml(t('summary.safeEditNotice'))}
            </div>
            <div class="amily2-historiography-safe-edit-error notes" role="alert" hidden></div>
          </div>
        `, {
          okText: t('summaryWorkflow.saveRevision'),
          cancelText: t('actions.cancel'),
          onShow: dialogElement => {
            const select = dialogElement.find(
              '#amily2_historiography_safe_edit_target',
            );
            const textarea = dialogElement.find(
              '#amily2_historiography_safe_edit_text',
            );
            const meta = dialogElement.find(
              '.amily2-historiography-safe-edit-meta',
            );
            const renderDocument = () => {
              const selected = snapshot.documents.find(document =>
                document.editId === String(select.val() || ''));
              textarea.val(selected?.text || '');
              if (!selected) {
                meta.text(t('summaryWorkflow.editTargetStale'));
                return;
              }
              const vector = selected.kind === 'macro-segment'
                ? t('summaryWorkflow.editVectorState', { state: selected.vectorState })
                : '';
              meta.text(
                t('summaryWorkflow.editMeta', { start: selected.startFloor, end: selected.endFloor, revision: snapshot.revision, vector }),
              );
            };
            select.on('change', renderDocument);
            renderDocument();
          },
          onOk: dialogElement => {
            const editId = String(dialogElement.find(
              '#amily2_historiography_safe_edit_target',
            ).val() || '');
            const replacementText = String(dialogElement.find(
              '#amily2_historiography_safe_edit_text',
            ).val() || '');
            const okButton = dialogElement.find('.popup-button-ok');
            const cancelButton = dialogElement.find('.popup-button-cancel');
            const inputs = dialogElement.find('select, textarea');
            const inlineError = dialogElement.find('.amily2-historiography-safe-edit-error');
            inlineError.text('').prop('hidden', true);
            okButton.prop('disabled', true).text(t('summaryWorkflow.saving'));
            cancelButton.prop('disabled', true);
            inputs.prop('disabled', true);
            void (async () => {
              try {
                const result = await applyActiveLedgerSafeEdit(
                  snapshot,
                  editId,
                  replacementText,
                );
                if (result?.idempotent) {
                  toastr.info(t('summaryWorkflow.unchanged'), t('summaryWorkflow.safeEdit'));
                } else if (result?.vectorInvalidated) {
                  toastr.warning(
                    t('summary.largeSafelyEdited'),
                    t('summaryWorkflow.safeEdit'),
                    { timeOut: 12000 },
                  );
                } else {
                  toastr.success(
                    t('summary.smallSafelyEdited'),
                    t('summaryWorkflow.safeEdit'),
                  );
                }
                dialogElement[0].close();
                dialogElement.remove();
                await refreshLedgerStatus();
              } catch (error) {
                const message = t('summaryWorkflow.editFailed', { error: error.message });
                inlineError.text(message).prop('hidden', false);
                inlineError[0]?.scrollIntoView?.({ block: 'nearest' });
                toastr.error(_escapeHtml(t('summaryWorkflow.editFailed', { error: error.message })), t('summaryWorkflow.safeEdit'), {
                  timeOut: 12000,
                });
                okButton.prop('disabled', false).text(t('summaryWorkflow.saveRevision'));
                cancelButton.prop('disabled', false);
                inputs.prop('disabled', false);
              }
            })();
            return false;
          },
          onCancel: () => {
            safeEditBtn.disabled = !canSafelyEditLedger(
              ledgerStatusSnapshot,
            );
          },
        });
        dialog.on('close', () => {
          safeEditBtn.disabled = !canSafelyEditLedger(
            ledgerStatusSnapshot,
          );
        });
      } catch (error) {
        toastr.error(_escapeHtml(t('summaryWorkflow.openEditFailed', { error: error.message })), t('summaryWorkflow.safeEdit'), {
          timeOut: 12000,
        });
      } finally {
        if (!document.querySelector('.amily2-historiography-safe-edit')) {
          safeEditBtn.disabled = !canSafelyEditLedger(
            ledgerStatusSnapshot,
          );
        }
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
          t('summaryWorkflow.invalidNumber', { min, max, value: defaultSettings[key] }),
          t('summary.largeSettings'),
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
        toastr.warning(warning, t('summary.largeSettings'));
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
          t('summaryWorkflow.invalidInputLimit'),
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
          t('summary.inputReserveAdjusted', {
            reserve: REFINEMENT_INPUT_RESERVE_TOKENS,
            active: activeTokens,
          }),
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
          t('summary.activeLimitInvalid'),
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
          t('summary.inputLimitAdjusted', {
            reserve: REFINEMENT_INPUT_RESERVE_TOKENS,
            input: inputTokens,
          }),
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
    largeWbSelector.innerHTML = `<option value="" data-amily-i18n="summary.loadingWorldbooks">${_escapeHtml(t('summary.loadingWorldbooks'))}</option>`;
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
      largeWbSelector.innerHTML = `<option value="" data-amily-i18n="summary.noWorldbooks">${_escapeHtml(t('summary.noWorldbooks'))}</option>`;
    }
  };

  const updateLoreList = async () => {
    const selectedWb = largeWbSelector.value;
    if (!selectedWb) {
      largeLoreSelector.innerHTML = `<option value="" data-amily-i18n="summary.selectWorldbook">${_escapeHtml(t('summary.selectWorldbook'))}</option>`;
      return;
    }
    largeLoreSelector.innerHTML = `<option value="" data-amily-i18n="summary.loadingEntries">${_escapeHtml(t('summary.loadingEntries'))}</option>`;
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
      largeLoreSelector.innerHTML = `<option value="" data-amily-i18n="summary.emptyWorldbook">${_escapeHtml(t('summary.emptyWorldbook'))}</option>`;
    }
  };

  largeRefreshWbBtn.addEventListener("click", updateWorldbookList);
  largeWbSelector.addEventListener("change", updateLoreList);
  largeRefreshLoresBtn.addEventListener("click", updateLoreList);

  largeRefineBtn.addEventListener("click", () => {
    const worldbook = largeWbSelector.value;
    const loreKey = largeLoreSelector.value;
    if (!worldbook || !loreKey) {
      toastr.error(t('summaryWorkflow.selectEntry'), t('summaryWorkflow.summary'));
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
            button.prop('disabled', true).html(`<i class="fas fa-spinner fa-spin"></i> ${_escapeHtml(t('summaryWorkflow.testing'))}`);
            
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
            button.prop('disabled', true).html(`<i class="fas fa-spinner fa-spin"></i> ${_escapeHtml(t('summaryWorkflow.fetching'))}`);
            
            try {
                const models = await fetchNgmsModels();
                
                if (models && models.length > 0) {
                    // 清空并填充模型下拉框
                    modelSelect.innerHTML = `<option value="" data-amily-i18n="summaryWorkflow.selectModel">${_escapeHtml(t('summaryWorkflow.selectModel'))}</option>`;
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
                    
                    toastr.success(t('summaryWorkflow.modelsFetched', { count: models.length }), t('summaryWorkflow.modelsTitle'));
                } else {
                    toastr.warning(t('summaryWorkflow.noModels'), t('summaryWorkflow.modelsTitle'));
                }
                
            } catch (error) {
                console.error('[Amily2号-Ngms] 获取模型列表失败:', error);
                toastr.error(_escapeHtml(t('summaryWorkflow.modelsFailed', { error: error.message })), t('summaryWorkflow.modelsTitle'));
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
    select.innerHTML = `<option value="" data-amily-i18n="summaryWorkflow.loading">${_escapeHtml(t('summaryWorkflow.loading'))}</option>`;

    try {
        const context = getContext();
        const tavernProfiles = context.extensionSettings?.connectionManager?.profiles || [];
        
        select.innerHTML = `<option value="" data-amily-i18n="summaryWorkflow.selectPreset">${_escapeHtml(t('summaryWorkflow.selectPreset'))}</option>`;
        
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
            select.innerHTML = `<option value="" data-amily-i18n="summaryWorkflow.noPresets">${_escapeHtml(t('summaryWorkflow.noPresets'))}</option>`;
        }
    } catch (error) {
        console.error('[Amily2号-Ngms] 加载SillyTavern预设失败:', error);
        select.innerHTML = `<option value="" data-amily-i18n="summaryWorkflow.loadFailed">${_escapeHtml(t('summaryWorkflow.loadFailed'))}</option>`;
    }
}

