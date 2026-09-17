/**
 * api-config-bindings.js — API 连接配置面板 UI 事件绑定
 *
 * 依赖：
 *   ApiProfileManager（数据层）
 *   ApiKeyStore（密钥存储）
 */

import { apiProfileManager, PROFILE_TYPES, SLOTS, clearLegacyConfig } from '../utils/config/ApiProfileManager.js';
import { t, apiTableHtml, apiTableAttr, setApiTableText, clearApiTableText, refreshApiTableTranslations } from './api-table-i18n.js';
import { apiKeyStore, CloudTransitionError } from '../utils/config/api-key-store/ApiKeyStore.js';
import {
    clearVaultDeviceKey,
    discardVaultEncryptedState,
    disableVaultSync,
    enableVaultSync,
    getVaultSyncStatus,
    reconcileVaultSync,
    subscribeVaultSyncStatus,
    VAULT_UNAVAILABLE_REASONS,
} from '../utils/config/api-key-store/vault-sync-controller.js';
import { restoreServerAuthorizationSession } from '../utils/auth.js';
import { configManager } from '../utils/config/ConfigManager.js';
import { getRequestHeaders, saveSettingsDebounced } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { extensionName, extensionBasePath } from '../utils/settings.js';
import { testApiConnection } from '../core/api.js';
import { getEmbeddings } from '../core/rag-api.js';
import { embeddingEndpointForProvider } from '../core/api/embedding-transport.js';
import { testJqyhApiConnection } from '../core/api/JqyhApi.js';
import { testConcurrentApiConnection } from '../core/api/ConcurrentApi.js';
import { testNgmsApiConnection } from '../core/api/Ngms_api.js';
import { testNccsApiConnection } from '../core/api/NccsApi.js';
import { showContentModal } from './page-window.js';
import { acquireProfileRequestPermit, bindSlotProfileRateLimit } from '../core/api/api-resolver.js';
import { isOfficialDeepSeekEndpoint } from '../core/api/deepseek-tool-routing.js';
import { readOpenAICompatibleResponse } from '../core/api/streaming-response.js';
import {
    getRegistry,
    detectVendorSync,
    listVendorParamsSync,
    getVendorEntry,
} from '../utils/api-vendor.js';

// 槽位 → 真实测试函数映射（发送聊天请求验证连接）
// plotOpt 槽位同时服务剧情优化和 JQYH（互斥），根据启用状态选择测试函数
const SLOT_TEST_FNS = {
    main:        testApiConnection,
    plotOpt:     () => {
        const s = extension_settings[extensionName] || {};
        return s.jqyhEnabled ? testJqyhApiConnection() : testApiConnection();
    },
    plotOptConc: testConcurrentApiConnection,
    ngms:        testNgmsApiConnection,
    nccs:        testNccsApiConnection,
};

// 槽位 → 功能总开关映射
// key        : extension_settings[extensionName] 中的设置键（支持 a.b.c 嵌套）
// checkbox   : 原面板中对应 checkbox 的 DOM 选择器（用于双向同步）
// defaultTrue: 未写过设置时视为开启（与各模块「默认开」语义一致）
const SLOT_TOGGLES = {
    main:         { key: 'optimizationEnabled',                          checkbox: '#amily2_optimization_enabled' },
    plotOpt:      { key: 'plotOpt_enabled',                              checkbox: '#amily2_opt_enabled' },
    plotOptConc:  { key: 'plotOpt_concurrentEnabled',                    checkbox: '#amily2_plotOpt_concurrentEnabled' },
    ngms:         { key: 'ngmsEnabled',                                  checkbox: '#amily2_ngms_enabled' },
    nccs:         { key: 'nccsEnabled',                                  checkbox: '#nccs-api-enabled' },
    cwb:          { key: 'cwb_master_enabled',                           checkbox: '#cwb_master_enabled-checkbox' },
    autoCharCard: { key: 'autoCharCardEnabled',                          checkbox: '#acc_master_enabled', defaultTrue: true },
    sybd:         { key: 'sybdEnabled',                                  checkbox: '#amily2_sybd_enabled', defaultTrue: true },
    tableFilling: { key: 'table_system_enabled',                         checkbox: '#table-system-master-switch', defaultTrue: true },
    // 初次检索与结果重排各自使用原面板开关，关闭重排不能关闭 Embedding 检索。
    ragEmbed:     { key: 'hanlinyuan-rag-core.retrieval.enabled',         checkbox: '#hly-retrieval-enabled' },
    ragRerank:    { key: 'hanlinyuan-rag-core.rerank.enabled',            checkbox: '#hly-rerank-enabled' },
};

function _getByPath(obj, path) {
    if (!obj || !path) return undefined;
    if (!path.includes('.')) return obj[path];
    return path.split('.').reduce((cur, k) => (cur == null ? undefined : cur[k]), obj);
}

function _setByPath(obj, path, value) {
    if (!obj || !path) return;
    if (!path.includes('.')) {
        obj[path] = value;
        return;
    }
    const keys = path.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
        cur = cur[k];
    }
    cur[keys[keys.length - 1]] = value;
}

function _readSlotToggle(settings, toggle) {
    const val = _getByPath(settings, toggle.key);
    if (toggle.defaultTrue) return val !== false;
    return !!val;
}

// ── 状态 ─────────────────────────────────────────────────────────────────────

let _editingId      = null;   // 当前编辑的 Profile ID（null = 新建）
let _currentFilter  = 'all';  // 当前类型筛选
let _slotAssignmentPanel = null;
let _slotAssignmentRefreshBound = false;
let _vaultSyncPanel = null;
let _vaultSyncUnsubscribe = null;

// ── 入口：绑定整个面板 ────────────────────────────────────────────────────────

export function bindApiConfigPanel(container) {
    const $c = $(container);
    _slotAssignmentPanel = $c;

    if (!_slotAssignmentRefreshBound) {
        _slotAssignmentRefreshBound = true;
        document.addEventListener('amily2:slotAssigned', () => {
            if (_slotAssignmentPanel) renderSlotAssignments(_slotAssignmentPanel);
        });
    }

    // 教程：连接类型 + 分配开关说明
    $c.off('click.amily2.apiTutorial', '#amily2_open_api_config_tutorial')
      .on('click.amily2.apiTutorial', '#amily2_open_api_config_tutorial', () => {
          showContentModal(t('apiTableUi.api.tutorial'), `${extensionBasePath}/ApiConfig.md`, {
              advancedTitle: t('apiTableUi.api.advancedTutorial'),
              advancedUrl: `${extensionBasePath}/ApiConfig-Advanced.md`,
          });
      });

    // 顶部分段：连接 / 分配 / 更多
    $c.on('click', '.am2-ac-tab', function () {
        _switchAcTab($c, $(this).data('ac-tab'));
    });

    // 存储模式
    _bindStorageMode($c);

    // 类型筛选
    $c.on('click', '.amily2_profile_type_filter', function () {
        $c.find('.amily2_profile_type_filter').removeClass('active');
        $(this).addClass('active');
        _currentFilter = $(this).data('type');
        renderProfileList($c);
    });

    // 新建 Profile
    $c.find('#amily2_add_profile').on('click', () => openModal($c, null));

    // 类型切换时显示/隐藏专有参数
    $c.find('#amily2_pf_type').on('change', function () {
        _resetProfileTypeFields($c);
        $c.find('#amily2_pf_model').val('').show();
        $c.find('#amily2_pf_model_select').hide().empty();
        $c.find('#amily2_pf_test_result').text('');
        _switchParamSections($c, $(this).val());
    });

    // 接口类型切换 —— vendor preset 自动填 defaultUrl + 切换提示框
    $c.find('#amily2_pf_provider').on('change', async function () {
        const provider = $(this).val();
        _handleProviderChange($c, provider);
        await _autofillVendorUrl($c, provider);
    });

    // 获取模型列表
    $c.find('#amily2_pf_fetch_models').on('click', () => _fetchModels($c));

    // 测试连接
    $c.find('#amily2_pf_test_conn').on('click', () => _testConnection($c));

    // URL 变更 → 更新 customParams hint
    $c.find('#amily2_pf_url').on('input change blur', () => _updateCustomParamsHint($c));

    // customParams 文本框实时校验 JSON
    $c.find('#amily2_pf_custom_params').on('blur input', () => {
        _validateCustomParamsLive($c);
        _updateCustomParamsHint($c);
    });

    $c.on('click', '.amily2_param_hint_btn', function () {
        if (this.disabled) return;
        _insertParamToCustomParams(
            $c,
            $(this).data('paramName'),
            $(this).data('paramType')
        );
    });

    // 预加载 vendor registry（异步，UI 不阻塞）
    getRegistry().catch(() => { /* 失败已在 api-vendor 内部 fallback，无需再处理 */ });

    // 旧配置清理按钮
    $c.find('#amily2_clear_legacy_config').on('click', () => _handleClearLegacyConfig($c));

    // 表单：取消 / 返回列表
    $c.find('#amily2_profile_modal_cancel').on('click', () => closeModal($c));

    // 保存
    $c.find('#amily2_profile_modal_save').on('click', () => saveProfile($c));

    // 初始渲染
    closeModal($c);
    renderProfileList($c);
    renderSlotAssignments($c);
    refreshApiTableTranslations($c[0]);
}

// ── 存储模式 ──────────────────────────────────────────────────────────────────

const VAULT_STATUS_COPY = Object.freeze({
    disabled: Object.freeze({ badge: 'apiTableUi.vault.disabledBadge', message: 'apiTableUi.vault.disabledMessage' }),
    unavailable: Object.freeze({ badge: 'apiTableUi.vault.unavailableBadge', message: 'apiTableUi.vault.unavailableMessage' }),
    idle: Object.freeze({ badge: 'apiTableUi.vault.idleBadge', message: 'apiTableUi.vault.idleMessage' }),
    checking: Object.freeze({ badge: 'apiTableUi.vault.checkingBadge', message: 'apiTableUi.vault.checkingMessage' }),
    'migration-pending': Object.freeze({ badge: 'apiTableUi.vault.migrationBadge', message: 'apiTableUi.vault.migrationMessage' }),
    'recovery-pending': Object.freeze({ badge: 'apiTableUi.vault.recoveryBadge', message: 'apiTableUi.vault.recoveryMessage' }),
    'cleanup-pending': Object.freeze({ badge: 'apiTableUi.vault.cleanupBadge', message: 'apiTableUi.vault.cleanupMessage' }),
    'remote-empty': Object.freeze({ badge: 'apiTableUi.vault.emptyBadge', message: 'apiTableUi.vault.emptyMessage' }),
    synced: Object.freeze({ badge: 'apiTableUi.vault.syncedBadge', message: 'apiTableUi.vault.syncedMessage' }),
    restored: Object.freeze({ badge: 'apiTableUi.vault.restoredBadge', message: 'apiTableUi.vault.restoredMessage' }),
    conflict: Object.freeze({ badge: 'apiTableUi.vault.conflictBadge', message: 'apiTableUi.vault.conflictMessage' }),
    error: Object.freeze({ badge: 'apiTableUi.vault.errorBadge', message: 'apiTableUi.vault.errorMessage' }),
});
const VAULT_SESSION_CREDENTIAL_COPY = Object.freeze({
    badge: 'apiTableUi.vault.sessionBadge',
    message: 'apiTableUi.vault.sessionMessage',
});
const VAULT_UNAVAILABLE_REASON_VALUES = new Set(Object.values(VAULT_UNAVAILABLE_REASONS));
const API_KEY_STORAGE_EVENT_NAMESPACE = '.amily2.apiKeyStorage';

function _normalizeVaultSyncStatus(snapshot) {
    const raw = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const status = Object.prototype.hasOwnProperty.call(VAULT_STATUS_COPY, raw.status)
        ? raw.status
        : 'error';
    const revision = Number(raw.revision);
    const fingerprint = typeof raw.fingerprint === 'string'
        && /^sha256:[0-9a-f]{64}$/u.test(raw.fingerprint)
        ? raw.fingerprint
        : null;
    const reason = typeof raw.reason === 'string'
        && VAULT_UNAVAILABLE_REASON_VALUES.has(raw.reason)
        ? raw.reason
        : null;
    return Object.freeze({
        enabled: raw.enabled === true,
        status,
        revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
        fingerprint,
        reason,
        canUseRemote: raw.canUseRemote === true,
        canOverwriteRemote: raw.canOverwriteRemote === true,
        canDiscardEncrypted: raw.canDiscardEncrypted === true,
        canClearDeviceKey: raw.canClearDeviceKey === true,
    });
}

function _renderVaultSyncStatus($c, snapshot = getVaultSyncStatus()) {
    const state = _normalizeVaultSyncStatus(snapshot);
    const missingSessionCredential = state.status === 'unavailable'
        && state.reason === VAULT_UNAVAILABLE_REASONS.SESSION_CREDENTIAL_MISSING;
    const copy = missingSessionCredential
        ? VAULT_SESSION_CREDENTIAL_COPY
        : VAULT_STATUS_COPY[state.status];
    const busy = [
        'checking',
        'migration-pending',
        'cleanup-pending',
    ].includes(state.status);
    const canClearDeviceKey = ['synced', 'restored'].includes(state.status)
        && state.canClearDeviceKey;
    const $syncButton = $c.find('#amily2_vault_sync_now');
    const $recovery = $c.find('#amily2_vault_session_recovery');
    const $recoveryInput = $c.find('#amily2_vault_reauth_code');
    const $recoveryButton = $c.find('#amily2_vault_reauth_submit');

    $c.find('#amily2_keystore_mode').prop('disabled', busy);
    setApiTableText($c.find('#amily2_vault_sync_badge').attr('data-state', state.status), copy.badge);
    setApiTableText($c.find('#amily2_vault_sync_status'), copy.message);
    const $revision = $c.find('#amily2_vault_sync_revision')
        .prop('hidden', state.revision === 0 && !state.fingerprint);
    if (state.revision > 0 || state.fingerprint) {
        setApiTableText($revision, state.revision > 0
            ? (state.fingerprint ? 'apiTableUi.vault.revisionFingerprint' : 'apiTableUi.vault.revision')
            : 'apiTableUi.vault.fingerprint', { revision: state.revision, fingerprint: state.fingerprint });
    } else {
        clearApiTableText($revision).text('');
    }

    $syncButton.prop('disabled', busy || !state.enabled || state.status === 'unavailable');
    $syncButton.find('.vbtn-icon i').toggleClass('fa-spin', busy);
    setApiTableText($syncButton.find('.vbtn-label'), busy ? 'apiTableUi.vault.syncing' : 'apiTableUi.vault.syncNow');
    $c.find('#amily2_vault_use_remote')
        .prop('hidden', !state.canUseRemote)
        .prop('disabled', busy);
    $c.find('#amily2_vault_use_local')
        .prop('hidden', !state.canOverwriteRemote)
        .prop('disabled', busy);
    $c.find('#amily2_vault_discard_encrypted')
        .prop('hidden', !state.canDiscardEncrypted)
        .prop('disabled', busy || !state.canDiscardEncrypted);
    $c.find('#amily2_vault_clear_device_key').prop('disabled', busy || !canClearDeviceKey);
    $recovery.prop('hidden', !missingSessionCredential);
    $recoveryInput.prop('disabled', busy || !missingSessionCredential);
    $recoveryButton.prop('disabled', busy || !missingSessionCredential);
    if (!missingSessionCredential) $recoveryInput.val('');
}

async function _runVaultSyncAction($c, action, options = {}) {
    const successStatuses = Array.isArray(options.successStatuses)
        ? options.successStatuses
        : [];
    $c.find([
        '#amily2_vault_sync_now',
        '#amily2_vault_use_remote',
        '#amily2_vault_use_local',
        '#amily2_vault_clear_device_key',
        '#amily2_vault_discard_encrypted',
        '#amily2_vault_reauth_code',
        '#amily2_vault_reauth_submit',
        '#amily2_keystore_mode',
    ].join(',')).prop('disabled', true);
    try {
        const snapshot = await action();
        const state = _normalizeVaultSyncStatus(snapshot);
        _renderVaultSyncStatus($c, state);
        if (options.successMessage && successStatuses.includes(state.status)) {
            toastr.success(t(options.successMessage));
        }
        return state;
    } catch {
        // Vault exceptions may carry transport details. Keep credentials and remote
        // responses out of the DOM/toast and let the controller publish safe status.
        console.warn('[ApiConfig] 授权码云同步操作失败。');
        _renderVaultSyncStatus($c);
        toastr.error(t('apiTableUi.vault.operationFailed'));
        return null;
    }
}

const MANUAL_CLOUD_RECOVERY_COPY = Object.freeze({
    'needs-import': 'apiTableUi.vault.manualNeedsImport',
    ready: 'apiTableUi.vault.manualReady',
    conflict: 'apiTableUi.vault.manualConflict',
    invalid: 'apiTableUi.vault.manualInvalid',
});

function _normalizeManualCloudState(raw) {
    const state = typeof raw?.state === 'string' ? raw.state : 'invalid';
    if (state === 'needs-private-key') return 'needs-import';
    if (state === 'damaged') return 'invalid';
    return ['empty', 'ready', 'needs-import', 'conflict', 'invalid'].includes(state)
        ? state
        : 'invalid';
}

function _showManualCloudRecovery($c, state) {
    const copy = MANUAL_CLOUD_RECOVERY_COPY[state] || MANUAL_CLOUD_RECOVERY_COPY.invalid;
    setApiTableText($c.find('#amily2_manual_cloud_recovery_status'), copy);
    $c.find('#amily2_manual_cloud_recovery').prop('hidden', false);
}

function _hideManualCloudRecovery($c) {
    $c.find('#amily2_manual_cloud_recovery').prop('hidden', true);
}

function _chooseManualCloudConflictStrategy() {
    const useRemote = confirm(t('apiTableUi.vault.chooseCloud'));
    if (useRemote) return 'use-cloud';

    const overwriteRemote = confirm(t('apiTableUi.vault.chooseLocal'));
    return overwriteRemote ? 'overwrite-cloud' : null;
}

function _isManualCloudChoiceError(error) {
    return error instanceof CloudTransitionError
        || error?.code === 'MANUAL_CLOUD_NEEDS_CHOICE';
}

function _bindStorageMode($c) {
    const $select = $c.find('#amily2_keystore_mode');
    const $cloud  = $c.find('#amily2_cloud_key_section');
    const $vault  = $c.find('#amily2_vault_sync_section');
    const $note   = $c.find('#amily2_keystore_mode_note');
    const $importInput = $c.find('#amily2_import_key_bundle_input');
    let manualCloudImportInspection = null;

    const MODE_NOTES = {
        local: 'apiTableUi.vault.localNote',
        cloud: 'apiTableUi.vault.cloudNote',
        vault: 'apiTableUi.vault.vaultNote',
    };

    const renderMode = mode => {
        $select.val(mode);
        $cloud.toggle(mode === 'cloud' || mode === 'vault');
        $vault.prop('hidden', mode !== 'vault');
        setApiTableText($note, MODE_NOTES[mode] || MODE_NOTES.local);
        if (mode === 'cloud' || mode === 'vault') _refreshFingerprint($c);
        if (mode === 'vault') {
            _renderVaultSyncStatus($c);
        } else {
            $select.prop('disabled', false);
        }
    };

    // 初始状态
    const currentMode = apiKeyStore.getMode();
    renderMode(currentMode);

    if (_vaultSyncUnsubscribe) _vaultSyncUnsubscribe();
    _vaultSyncPanel = $c[0];
    _vaultSyncUnsubscribe = subscribeVaultSyncStatus(snapshot => {
        if (_vaultSyncPanel === $c[0]) _renderVaultSyncStatus($c, snapshot);
    });

    // 切换模式
    $select.off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`change${API_KEY_STORAGE_EVENT_NAMESPACE}`, async function () {
        const newMode = $(this).val();
        const previousMode = apiKeyStore.getMode();
        const vaultStatusBeforeChange = _normalizeVaultSyncStatus(getVaultSyncStatus());
        const pendingVaultChoice = previousMode !== 'vault'
            && vaultStatusBeforeChange.enabled
            && vaultStatusBeforeChange.status === 'conflict';
        if (newMode === previousMode && !pendingVaultChoice) return;
        let manualCloudStrategy = 'auto';
        let manualCloudInspection = null;
        const confirmations = {
            local: previousMode === 'vault'
                ? 'apiTableUi.vault.vaultToLocal'
                : 'apiTableUi.vault.cloudToLocal',
            cloud: previousMode === 'vault'
                ? 'apiTableUi.vault.vaultToCloud'
                : 'apiTableUi.vault.enableCloudConfirm',
            vault: 'apiTableUi.vault.enableVaultConfirm',
        };
        if (newMode === 'cloud' && previousMode === 'local') {
            let manualCloudState;
            try {
                manualCloudInspection = await apiKeyStore.inspectManualCloudState();
                manualCloudState = _normalizeManualCloudState(manualCloudInspection);
            } catch {
                manualCloudState = 'invalid';
            }
            if (manualCloudState === 'needs-import' || manualCloudState === 'invalid') {
                renderMode(previousMode);
                _showManualCloudRecovery($c, manualCloudState);
                toastr.warning(t(MANUAL_CLOUD_RECOVERY_COPY[manualCloudState]));
                return;
            }
            _hideManualCloudRecovery($c);
            if (manualCloudState === 'conflict') {
                manualCloudStrategy = _chooseManualCloudConflictStrategy();
                if (!manualCloudStrategy) {
                    renderMode(previousMode);
                    return;
                }
            } else if (!confirm(t(confirmations.cloud))) {
                renderMode(previousMode);
                return;
            }
        } else if (!confirm(t(confirmations[newMode]))) {
            renderMode(previousMode);
            return;
        }

        $select.prop('disabled', true);
        if (pendingVaultChoice) {
            await disableVaultSync({ targetMode: previousMode, interactive: true });
            if (newMode === previousMode) {
                renderMode(previousMode);
                return;
            }
        }
        if (newMode === 'vault') {
            _hideManualCloudRecovery($c);
            const state = await _runVaultSyncAction(
                $c,
                () => enableVaultSync({ interactive: true }),
                {
                    successStatuses: ['synced', 'restored'],
                    successMessage: 'apiTableUi.vault.enabled',
                },
            );
            if (state && ['error', 'unavailable', 'remote-empty'].includes(state.status)) {
                toastr.warning(t('apiTableUi.vault.notEnabled'));
            }
            // A fingerprint conflict deliberately does not commit Vault mode,
            // but its resolution controls live in the Vault panel. Other
            // failures must render the actually committed storage mode instead
            // of leaving a selected-but-disabled Vault option on screen.
            const pendingState = state?.status === 'conflict';
            renderMode(pendingState ? 'vault' : apiKeyStore.getMode());
            if (pendingState) _renderVaultSyncStatus($c, state);
            return;
        }

        if (previousMode === 'vault') {
            await _runVaultSyncAction(
                $c,
                () => disableVaultSync({ targetMode: newMode, interactive: true }),
                {
                    successStatuses: ['disabled'],
                    successMessage: 'apiTableUi.vault.disabledMessage',
                },
            );
            renderMode(apiKeyStore.getMode());
            return;
        }

        try {
            const transitionOptions = (inspection) => ({
                strategy: manualCloudStrategy,
                expectedRemoteToken: inspection?.remoteSnapshotToken ?? null,
                expectedLocalMutationRevision: inspection?.localMutationRevision ?? null,
            });
            try {
                await apiKeyStore.setMode(newMode, transitionOptions(manualCloudInspection));
            } catch (error) {
                if (newMode !== 'cloud' || previousMode !== 'local'
                    || !_isManualCloudChoiceError(error)) throw error;
                manualCloudInspection = await apiKeyStore.inspectManualCloudState();
                const refreshedState = _normalizeManualCloudState(manualCloudInspection);
                if (refreshedState === 'needs-import' || refreshedState === 'invalid') {
                    throw new Error('The shared encrypted credential image is not recoverable on this device.');
                }
                manualCloudStrategy = _chooseManualCloudConflictStrategy();
                if (!manualCloudStrategy) {
                    renderMode(previousMode);
                    return;
                }
                await apiKeyStore.setMode(newMode, transitionOptions(manualCloudInspection));
            }
            if (newMode === 'cloud') {
                await configManager.syncSensitiveCache({ force: true });
            }
            _hideManualCloudRecovery($c);
            renderMode(newMode);
            const modeName = t(newMode === 'vault'
                ? 'apiTableUi.vault.vaultMode'
                : newMode === 'cloud' ? 'apiTableUi.vault.cloudMode' : 'apiTableUi.vault.localMode');
            toastr.success(t('apiTableUi.vault.modeChanged', { mode: modeName }));
        } catch {
            console.warn('[ApiConfig] 密钥存储模式切换失败。');
            toastr.error(t('apiTableUi.vault.modeFailed'));
            renderMode(apiKeyStore.getMode());
            return;
        }
    });

    $c.find('#amily2_vault_sync_now')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`click${API_KEY_STORAGE_EVENT_NAMESPACE}`, () => _runVaultSyncAction(
            $c,
            () => reconcileVaultSync({ strategy: 'auto', interactive: true }),
            {
                successStatuses: ['synced', 'restored'],
                successMessage: 'apiTableUi.vault.syncComplete',
            },
        ));

    const restoreVaultSessionCredential = async () => {
        const state = _normalizeVaultSyncStatus(getVaultSyncStatus());
        if (state.status !== 'unavailable'
            || state.reason !== VAULT_UNAVAILABLE_REASONS.SESSION_CREDENTIAL_MISSING) {
            _renderVaultSyncStatus($c, state);
            return;
        }

        const $input = $c.find('#amily2_vault_reauth_code');
        let credential = String($input.val() || '').trim();
        $input.val('');
        if (!credential || credential.length > 512) {
            credential = '';
            toastr.warning(t('apiTableUi.vault.codeRequired'));
            return;
        }

        $input.prop('disabled', true);
        $c.find('#amily2_vault_reauth_submit').prop('disabled', true);
        try {
            const restored = await restoreServerAuthorizationSession(credential);
            credential = '';
            if (!restored) {
                _renderVaultSyncStatus($c);
                toastr.error(t('apiTableUi.vault.restoreFailed'));
                return;
            }
            await _runVaultSyncAction(
                $c,
                () => reconcileVaultSync({ strategy: 'auto', interactive: true }),
                {
                    successStatuses: ['synced', 'restored'],
                    successMessage: 'apiTableUi.vault.sessionRestored',
                },
            );
        } finally {
            credential = '';
            _renderVaultSyncStatus($c);
        }
    };

    $c.find('#amily2_vault_reauth_submit')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`click${API_KEY_STORAGE_EVENT_NAMESPACE}`, restoreVaultSessionCredential);
    $c.find('#amily2_vault_reauth_code')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`keydown${API_KEY_STORAGE_EVENT_NAMESPACE}`, event => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void restoreVaultSessionCredential();
        });

    $c.find('#amily2_vault_use_remote')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`click${API_KEY_STORAGE_EVENT_NAMESPACE}`, () => {
        if (!confirm(t('apiTableUi.vault.useRemoteConfirm'))) return;
        const expectedRemote = _normalizeVaultSyncStatus(getVaultSyncStatus());
        _runVaultSyncAction(
            $c,
            () => reconcileVaultSync({
                strategy: 'use-remote',
                expectedRemote: {
                    revision: expectedRemote.revision,
                    fingerprint: expectedRemote.fingerprint,
                },
                interactive: true,
            }),
            {
                successStatuses: ['synced', 'restored'],
                successMessage: 'apiTableUi.vault.remoteAdopted',
            },
        );
    });

    $c.find('#amily2_vault_use_local')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`click${API_KEY_STORAGE_EVENT_NAMESPACE}`, () => {
        const expectedRemote = _normalizeVaultSyncStatus(getVaultSyncStatus());
        const remoteIsEmpty = expectedRemote.revision === 0 && !expectedRemote.fingerprint;
        if (!confirm(remoteIsEmpty
            ? t('apiTableUi.vault.initializeConfirm')
            : t('apiTableUi.vault.overwriteConfirm'))) return;
        _runVaultSyncAction(
            $c,
            () => reconcileVaultSync({
                strategy: remoteIsEmpty ? 'initialize-remote' : 'overwrite-remote',
                expectedRemote: {
                    revision: expectedRemote.revision,
                    fingerprint: expectedRemote.fingerprint,
                },
                interactive: true,
            }),
            {
                successStatuses: ['synced'],
                successMessage: 'apiTableUi.vault.remoteUpdated',
            },
        );
    });

    $c.find('#amily2_vault_clear_device_key')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`click${API_KEY_STORAGE_EVENT_NAMESPACE}`, () => {
            const state = _normalizeVaultSyncStatus(getVaultSyncStatus());
            const safeToClear = ['synced', 'restored'].includes(state.status)
                && state.canClearDeviceKey;
            if (!safeToClear) {
                _renderVaultSyncStatus($c, state);
                toastr.warning(t('apiTableUi.vault.clearBlocked'));
                return;
            }
            if (!confirm(t('apiTableUi.vault.clearConfirm'))) return;
            _runVaultSyncAction($c, () => clearVaultDeviceKey());
        });

    $c.find('#amily2_vault_discard_encrypted')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`click${API_KEY_STORAGE_EVENT_NAMESPACE}`, async () => {
            if (apiKeyStore.getMode() !== 'vault') return;
            const state = _normalizeVaultSyncStatus(getVaultSyncStatus());
            if (!state.canDiscardEncrypted) {
                _renderVaultSyncStatus($c, state);
                return;
            }
            if (!confirm(t('apiTableUi.vault.discardConfirm'))) return;
            try {
                const result = await discardVaultEncryptedState();
                if (!result || result.status !== 'disabled') {
                    _renderVaultSyncStatus($c, result);
                    return;
                }
                renderMode('local');
                toastr.warning(t('apiTableUi.vault.discarded'));
            } catch {
                toastr.error(t('apiTableUi.vault.discardFailed'));
            }
        });

    // 重新生成密钥对
    $c.find('#amily2_generate_keypair')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`click${API_KEY_STORAGE_EVENT_NAMESPACE}`, async () => {
        if (apiKeyStore.getMode() === 'vault') {
            toastr.info(t('apiTableUi.vault.manualBeforeGenerate'));
            return;
        }
        let keyRotationInspection;
        try {
            keyRotationInspection = await apiKeyStore.inspectManualCloudState();
        } catch {
            toastr.error(t('apiTableUi.vault.generateInspectionFailed'));
            return;
        }
        const keyRotationState = _normalizeManualCloudState(keyRotationInspection);
        if (apiKeyStore.getMode() === 'local' && keyRotationState !== 'empty') {
            _showManualCloudRecovery($c, keyRotationState);
            toastr.warning(t('apiTableUi.vault.generateBackupBlocked'));
            return;
        }
        if (apiKeyStore.getMode() === 'cloud'
            && (keyRotationState === 'needs-import' || keyRotationState === 'invalid')) {
            toastr.warning(t('apiTableUi.vault.generateVerifyBlocked'));
            return;
        }
        if (!confirm(t('apiTableUi.vault.generateConfirm'))) return;
        try {
            await apiKeyStore.generateKeyPair({
                expectedRemoteToken: keyRotationInspection.remoteSnapshotToken,
                expectedLocalMutationRevision: keyRotationInspection.localMutationRevision,
            });
            await _refreshFingerprint($c);
            toastr.warning(t('apiTableUi.vault.generated'));
        } catch {
            toastr.error(t('apiTableUi.vault.generateFailed'));
        }
    });

    $c.find('#amily2_export_key_bundle')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`click${API_KEY_STORAGE_EVENT_NAMESPACE}`, async () => {
        try {
            const bundle = await apiKeyStore.exportPrivateKeyBundle();
            _downloadJson(
                `amily2-keystore-${_timestampForFilename()}.json`,
                bundle
            );
            toastr.success(t('apiTableUi.vault.exported'));
        } catch {
            console.warn('[ApiConfig] 导出私钥包失败。');
            toastr.error(t('apiTableUi.vault.exportFailed'));
        }
    });

    $c.find('#amily2_manual_cloud_recovery_import')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`click${API_KEY_STORAGE_EVENT_NAMESPACE}`, async () => {
        if (apiKeyStore.getMode() !== 'local') {
            toastr.info(t('apiTableUi.vault.recoveryLocalOnly'));
            return;
        }
        try {
            manualCloudImportInspection = await apiKeyStore.inspectManualCloudState();
        } catch {
            toastr.error(t('apiTableUi.vault.openImportFailed'));
            return;
        }
        renderMode('local');
        $importInput.val('');
        $importInput.trigger('click');
    });

    $c.find('#amily2_import_key_bundle')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`click${API_KEY_STORAGE_EVENT_NAMESPACE}`, async () => {
        if (apiKeyStore.getMode() === 'vault') {
            toastr.info(t('apiTableUi.vault.manualBeforeImport'));
            return;
        }
        try {
            manualCloudImportInspection = await apiKeyStore.inspectManualCloudState();
        } catch {
            toastr.error(t('apiTableUi.vault.openImportFailed'));
            return;
        }
        $importInput.val('');
        $importInput.trigger('click');
    });

    $importInput.off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`change${API_KEY_STORAGE_EVENT_NAMESPACE}`, async function () {
        const file = this.files?.[0];
        if (!file) return;
        if (apiKeyStore.getMode() === 'vault') {
            $importInput.val('');
            toastr.info(t('apiTableUi.vault.manualBeforeImport'));
            return;
        }

        if (!manualCloudImportInspection) {
            try {
                manualCloudImportInspection = await apiKeyStore.inspectManualCloudState();
            } catch {
                $importInput.val('');
                toastr.error(t('apiTableUi.vault.importInspectionFailed'));
                return;
            }
        }
        try {
            const importedWhileLocal = apiKeyStore.getMode() === 'local';
            const text = await file.text();
            await apiKeyStore.importPrivateKeyBundle(text, {
                expectedRemoteToken: manualCloudImportInspection?.remoteSnapshotToken ?? null,
                expectedLocalMutationRevision: manualCloudImportInspection?.localMutationRevision ?? null,
            });
            await _refreshFingerprint($c);
            if (importedWhileLocal) {
                let manualCloudState;
                try {
                    manualCloudState = _normalizeManualCloudState(
                        await apiKeyStore.inspectManualCloudState(),
                    );
                } catch {
                    manualCloudState = 'invalid';
                }
                _showManualCloudRecovery($c, manualCloudState);
                toastr.success(t('apiTableUi.vault.importedLocal'));
            } else {
                await configManager.syncSensitiveCache({ force: true });
                _hideManualCloudRecovery($c);
                toastr.success(t('apiTableUi.vault.imported'));
            }
        } catch {
            console.warn('[ApiConfig] 导入私钥包失败。');
            if (apiKeyStore.getMode() === 'local') {
                _showManualCloudRecovery($c, 'invalid');
            }
            toastr.error(t('apiTableUi.vault.importFailed'));
        } finally {
            manualCloudImportInspection = null;
            $importInput.val('');
        }
    });
}

async function _refreshFingerprint($c) {
    const fp = await apiKeyStore.getPublicKeyInfo();
    const $fingerprint = $c.find('#amily2_keypair_fingerprint');
    if (fp === '（未生成）') setApiTableText($fingerprint, 'apiTableUi.vault.notGenerated');
    else clearApiTableText($fingerprint).text(fp);
}

function _downloadJson(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function _timestampForFilename() {
    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

// ── Profile 列表渲染 ──────────────────────────────────────────────────────────

export function renderProfileList($c) {
    const $list = $c.find('#amily2_profile_list');
    const profiles = apiProfileManager.getProfiles(
        _currentFilter === 'all' ? undefined : _currentFilter
    );

    if (profiles.length === 0) {
        $list.html(
            '<div class="amily2_profile_empty am2-ac-empty">' +
            `<p>${apiTableHtml('apiTableUi.api.empty')}</p>` +
            `<small>${apiTableHtml('apiTableUi.api.emptyHelp')}</small>` +
            '</div>'
        );
        return;
    }

    const TYPE_CLASS = {
        chat: 'is-chat',
        embedding: 'is-embed',
        rerank: 'is-rerank',
    };

    const html = profiles.map(p => {
        const typeClass = TYPE_CLASS[p.type] || '';
        const selected = p.id === _editingId ? ' is-selected' : '';
        const connectionSource = p.connectionSourceId
            ? apiProfileManager.getProfile(p.connectionSourceId) : null;
        const connectionLabel = p.connectionSourceId
            ? (connectionSource?.name
                ? apiTableHtml('apiTableUi.api.inheritedFrom', { name: connectionSource.name })
                : apiTableHtml('apiTableUi.api.inheritedUnavailable'))
            : (p.apiUrl ? _escapeHtml(_truncateUrl(p.apiUrl)) : '');
        const sub = [
            apiTableHtml(PROFILE_TYPES[p.type] ? `apiTableUi.api.${p.type === 'chat' ? 'chatType' : p.type}` : 'apiTableUi.api.unknown'),
            p.model ? _escapeHtml(p.model) : apiTableHtml('apiTableUi.api.noModel'),
            connectionLabel,
        ].filter(Boolean).join(' · ');
        return `
            <div class="amily2_profile_card am2-ac-row${selected}" data-id="${_escapeHtml(p.id)}" role="button" tabindex="0">
            <span class="am2-ac-dot ${typeClass}" aria-hidden="true"></span>
            <div class="am2-ac-row-body">
                <div class="am2-ac-row-title">${_escapeHtml(p.name)}</div>
                <div class="am2-ac-row-sub">${sub}</div>
            </div>
            <button class="am2-ac-iconbtn amily2_duplicate_profile" data-id="${_escapeHtml(p.id)}" ${apiTableAttr('apiTableUi.api.duplicateHint')} ${apiTableAttr('apiTableUi.api.duplicate', {}, 'aria-label')} type="button">
                <i class="fas fa-copy"></i>
            </button>
            <button class="am2-ac-iconbtn amily2_delete_profile" data-id="${_escapeHtml(p.id)}" ${apiTableAttr('apiTableUi.common.delete')} type="button">
                <i class="fas fa-trash-alt"></i>
            </button>
            <i class="fas fa-chevron-right am2-ac-chevron" aria-hidden="true"></i>
        </div>`;
    }).join('');

    $list.html(html);

    // 整行点击进入编辑（操作按钮除外）
    $list.find('.am2-ac-row').on('click', function (e) {
        if ($(e.target).closest('.amily2_duplicate_profile, .amily2_delete_profile').length) return;
        openModal($c, $(this).data('id'));
    });
    $list.find('.am2-ac-row').on('keydown', function (e) {
        if ($(e.target).closest('.amily2_duplicate_profile, .amily2_delete_profile').length) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openModal($c, $(this).data('id'));
        }
    });
    $list.find('.amily2_duplicate_profile').on('click', async function (e) {
        e.stopPropagation();
        const $button = $(this);
        if ($button.prop('disabled')) return;
        const id = $button.data('id');
        const originalHtml = $button.html();
        $button.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i>');
        try {
            const duplicateId = await apiProfileManager.duplicateProfile(id);
            const duplicate = apiProfileManager.getProfile(duplicateId);
            renderProfileList($c);
            renderSlotAssignments($c);
            await openModal($c, duplicateId);
            toastr.success(t('apiTableUi.api.duplicated', { name: duplicate?.name || t('apiTableUi.api.derived') }));
        } catch (error) {
            console.error('[ApiConfig] 创建派生配置失败。', error);
            $button.prop('disabled', false).html(originalHtml);
            toastr.error(t('apiTableUi.api.duplicateFailed'));
        }
    });
    $list.find('.amily2_delete_profile').on('click', async function (e) {
        e.stopPropagation();
        const id   = $(this).data('id');
        const profile = apiProfileManager.getProfile(id);
        const name = profile?.name || id;
        const consequence = profile?.connectionSourceId
            ? t('apiTableUi.api.sourceUnchanged') : t('apiTableUi.api.keyDeleted');
        if (!confirm(t('apiTableUi.api.deleteConfirm', { name, consequence }))) return;
        try {
            await apiProfileManager.deleteProfile(id);
        } catch (error) {
            toastr.error(_profileDeleteErrorText(error));
            return;
        }
        if (_editingId === id) closeModal($c);
        renderProfileList($c);
        renderSlotAssignments($c);
        toastr.success(t('apiTableUi.api.deleted', { name }));
    });
}

// ── 功能槽分配渲染 ────────────────────────────────────────────────────────────

export function renderSlotAssignments($c) {
    const $slots = $c.find('#amily2_slot_assignments');

    const settings = extension_settings[extensionName] || {};

    // 按类型分组，减少一长串压迫感
    const groups = [
        { key: 'chat', title: 'apiTableUi.api.chatGroup' },
        { key: 'embedding', title: 'apiTableUi.api.retrievalGroup' },
        { key: 'rerank', title: 'apiTableUi.api.rerankGroup' },
    ];

    const entries = Object.entries(SLOTS);
    const html = groups.map(g => {
        const items = entries.filter(([, info]) => info.type === g.key);
        if (!items.length) return '';
        const rows = items.map(([slot, slotInfo]) => {
            const profiles = apiProfileManager.getProfiles(slotInfo.type);
            const assigned = apiProfileManager.getAssignment(slot) || '';
            const toggle   = SLOT_TOGGLES[slot];
            const options = [
                `<option value="" data-amily-i18n="apiTableUi.api.unassigned">${_escapeHtml(t('apiTableUi.api.unassigned'))}</option>`,
                ...profiles.map(p =>
                    `<option value="${_escapeHtml(p.id)}" ${p.id === assigned ? 'selected' : ''}>${_escapeHtml(p.name)}</option>`
                ),
            ].join('');

            const toggleHtml = toggle
                ? `<label class="toggle-switch am2-ac-switch" ${apiTableAttr('apiTableUi.api.toggleHint')}>
                       <input type="checkbox" class="amily2_slot_toggle" data-slot="${slot}" ${_readSlotToggle(settings, toggle) ? 'checked' : ''} />
                       <span class="slider"></span>
                   </label>`
                : '';

            return `
            <div class="am2-ac-setting ${assigned ? 'is-on' : ''}">
                <div class="am2-ac-setting-label">
                    <strong>${apiTableHtml(`apiTableUi.slot.${slot}`)}</strong>
                </div>
                <div class="am2-ac-setting-controls">
                    ${toggleHtml}
                    <select class="text_pole amily2_slot_select am2-ac-input am2-ac-input-sm" data-slot="${slot}">
                        ${options}
                    </select>
                    <button class="am2-ac-iconbtn amily2_slot_test" data-slot="${slot}"
                            ${apiTableAttr('apiTableUi.api.test')} type="button" ${assigned ? '' : 'disabled'}>
                        <i class="fas fa-bolt"></i>
                    </button>
                </div>
            </div>`;
        }).join('');
        return `<div class="am2-ac-group"><h3 class="am2-ac-group-title">${apiTableHtml(g.title)}</h3><div class="am2-ac-settings">${rows}</div></div>`;
    }).join('');

    $slots.html(html);

    $slots.find('.amily2_slot_select').on('change', function () {
        const slot = $(this).data('slot');
        const id   = $(this).val() || null;
        if (!apiProfileManager.setAssignment(slot, id)) {
            toastr.error(t('apiTableUi.api.assignmentFailed'));
            renderSlotAssignments($c);
            return;
        }
        document.dispatchEvent(new CustomEvent('amily2:slotAssigned', { detail: { slot } }));
        // 刷新行以更新测试按钮状态
        renderSlotAssignments($c);
    });

    // 槽位快捷测试按钮（调用各模块真实测试函数，发送聊天请求验证连接）
    $slots.find('.amily2_slot_test').on('click', async function () {
        const slot = $(this).data('slot');
        const $btn = $(this).prop('disabled', true);
        $btn.html('<i class="fas fa-spinner fa-spin"></i>');

        try {
            const testFn = SLOT_TEST_FNS[slot];
            if (!testFn) {
                toastr.warning(t('apiTableUi.api.testUnsupported'), slot);
                return;
            }
            const profile = await apiProfileManager.getAssignedProfile(slot);
            if (!profile) {
                toastr.warning(t('apiTableUi.api.slotUnassigned'), slot);
                return;
            }
            // 测试函数内部会显示 toastr 结果
            await testFn();
        } catch (e) {
            toastr.error(t('apiTableUi.api.testFailed', { error: _apiErrorText(e) }), slot);
        } finally {
            $btn.prop('disabled', false).html('<i class="fas fa-bolt"></i>');
        }
    });

    // 功能总开关：同步 extension_settings + 原面板 checkbox
    $slots.find('.amily2_slot_toggle').on('change', function () {
        const slot    = $(this).data('slot');
        const toggle  = SLOT_TOGGLES[slot];
        if (!toggle) return;

        const checked = this.checked;
        const currentEl = this;
        const s = extension_settings[extensionName];
        if (s) _setByPath(s, toggle.key, checked);

        // 如有多个槽明确绑定同一设置键，保持其开关 UI 一致。
        $slots.find('.amily2_slot_toggle').each(function () {
            const other = SLOT_TOGGLES[$(this).data('slot')];
            if (other && other.key === toggle.key && this !== currentEl && this.checked !== checked) {
                this.checked = checked;
            }
        });

        // 同步原面板的 checkbox（保持一致；触发其 change 以便模块侧逻辑跟进）
        const origCb = document.querySelector(toggle.checkbox);
        if (origCb && origCb.checked !== checked) {
            origCb.checked = checked;
            origCb.dispatchEvent(new Event('change', { bubbles: true }));
        }

        saveSettingsDebounced();
    });
}

// ── 弹窗操作 ──────────────────────────────────────────────────────────────────

function _switchAcTab($c, tab, { keepForm = false } = {}) {
    if (!tab) return;
    $c.find('.am2-ac-tab').removeClass('is-active').attr('aria-selected', 'false');
    $c.find(`.am2-ac-tab[data-ac-tab="${tab}"]`).addClass('is-active').attr('aria-selected', 'true');
    $c.find('.am2-ac-view').each(function () {
        const on = $(this).data('ac-view') === tab;
        $(this).toggleClass('is-active', on);
        if (on) this.removeAttribute('hidden');
        else this.setAttribute('hidden', '');
    });
    if (!keepForm && tab !== 'connections') {
        _hideFormOnly($c);
        _editingId = null;
        $c.find('.am2-ac-row').removeClass('is-selected');
    }
}

function _showFormPane($c, show) {
    const form = $c.find('#amily2_profile_form_details')[0];
    const list = $c.find('#amily2_profile_list_pane')[0];
    if (!form || !list) return;
    if (show) {
        form.removeAttribute('hidden');
        list.setAttribute('hidden', '');
        form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
        form.setAttribute('hidden', '');
        list.removeAttribute('hidden');
    }
}

function _hideFormOnly($c) {
    _showFormPane($c, false);
    $c.find('#amily2_pf_type').prop('disabled', false);
    $c.find('#amily2_pf_provider, #amily2_pf_url, #amily2_pf_key').prop('disabled', false);
    $c.find('#amily2_pf_connection_source_row').prop('hidden', true);
}

function _configureConnectionInheritance($c, profile) {
    const sourceId = profile?.connectionSourceId || null;
    const inherited = Boolean(sourceId);
    const source = sourceId ? apiProfileManager.getProfile(sourceId) : null;
    $c.find('#amily2_pf_connection_source_row').prop('hidden', !inherited);
    const $source = $c.find('#amily2_pf_connection_source');
    clearApiTableText($source, 'placeholder').val(inherited ? source?.name || '' : '').attr('placeholder', '');
    if (inherited && !source?.name) setApiTableText($source, 'apiTableUi.api.invalidSource', {}, 'placeholder');
    $c.find('#amily2_pf_provider, #amily2_pf_url, #amily2_pf_key').prop('disabled', inherited);
    const $key = $c.find('#amily2_pf_key');
    if (inherited) setApiTableText($key, source ? 'apiTableUi.api.keyInherited' : 'apiTableUi.api.sourceUnavailable', { name: source?.name }, 'placeholder');
    else clearApiTableText($key, 'placeholder').attr('placeholder', 'sk-…');
}

function _resetProfileTypeFields($c) {
    $c.find('#amily2_pf_max_tokens').val(65500);
    $c.find('#amily2_pf_temperature').val(1.0);
    $c.find('#amily2_pf_fake_stream').prop('checked', false);
    $c.find('#amily2_pf_custom_params, #amily2_pf_dimensions').val('');
    $c.find('#amily2_pf_encoding_format').val('float');
    $c.find('#amily2_pf_top_n').val(5);
    $c.find('#amily2_pf_return_documents').prop('checked', false);
}

async function openModal($c, id) {
    _switchAcTab($c, 'connections', { keepForm: true });
    _editingId = id;
    _resetProfileTypeFields($c);

    if (id) {
        const p = apiProfileManager.getProfile(id);
        if (!p) return;
        const $title = $c.find('#amily2_profile_modal_title');
        if (p.name) clearApiTableText($title).text(p.name);
        else setApiTableText($title, 'apiTableUi.api.editConnection');
        $c.find('#amily2_profile_form_icon').attr('class', 'fas fa-edit');
        const assigned = Object.keys(SLOTS).some(slot => apiProfileManager.getAssignment(slot) === id);
        $c.find('#amily2_pf_type').val(p.type).prop('disabled', !p.connectionSourceId || assigned);
        $c.find('#amily2_pf_name').val(p.name);
        $c.find('#amily2_pf_provider').val(p.provider);
        $c.find('#amily2_pf_url').val(p.apiUrl);
        $c.find('#amily2_pf_key').val('');
        $c.find('#amily2_pf_model').val(p.model);
        $c.find('#amily2_pf_rpm').val(p.rpm ?? 0);
        _configureConnectionInheritance($c, p);

        if (p.type === 'chat') {
            $c.find('#amily2_pf_max_tokens').val(p.maxTokens);
            $c.find('#amily2_pf_temperature').val(p.temperature);
            $c.find('#amily2_pf_fake_stream').prop('checked', p.fakeStream ?? false);
            const cp = p.customParams ?? {};
            $c.find('#amily2_pf_custom_params').val(
                Object.keys(cp).length ? JSON.stringify(cp, null, 2) : ''
            );
        } else if (p.type === 'embedding') {
            $c.find('#amily2_pf_dimensions').val(p.dimensions ?? '');
            $c.find('#amily2_pf_encoding_format').val(p.encodingFormat);
        } else if (p.type === 'rerank') {
            $c.find('#amily2_pf_top_n').val(p.topN);
            $c.find('#amily2_pf_return_documents').prop('checked', p.returnDocuments);
        }
        _switchParamSections($c, p.type);
        _handleProviderChange($c, p.provider);
    } else {
        setApiTableText($c.find('#amily2_profile_modal_title'), 'apiTableUi.api.addConnection');
        $c.find('#amily2_profile_form_icon').attr('class', 'fas fa-plus');
        $c.find('#amily2_pf_type').val('chat').prop('disabled', false);
        $c.find('#amily2_pf_name, #amily2_pf_url, #amily2_pf_key, #amily2_pf_model').val('');
        $c.find('#amily2_pf_provider').val('openai');
        _handleProviderChange($c, 'openai');
        _autofillVendorUrl($c, 'openai');
        $c.find('#amily2_pf_rpm').val(0);
        _configureConnectionInheritance($c, null);
        _switchParamSections($c, 'chat');
    }

    $c.find('#amily2_pf_test_result').text('');
    $c.find('#amily2_pf_model_select').hide().empty();
    $c.find('#amily2_pf_model').show();
    _updateCustomParamsHint($c);
    _validateCustomParamsLive($c);

    _showFormPane($c, true);
    $c.find('.am2-ac-row').removeClass('is-selected');
    if (id) $c.find(`.am2-ac-row[data-id="${id}"]`).addClass('is-selected');
}

function closeModal($c) {
    _hideFormOnly($c);
    _editingId = null;
    $c.find('.am2-ac-row').removeClass('is-selected');
}

async function saveProfile($c) {
    const existingProfile = _editingId ? apiProfileManager.getProfile(_editingId) : null;
    const inheritsConnection = Boolean(existingProfile?.connectionSourceId);
    const type     = $c.find('#amily2_pf_type').val();
    const name     = $c.find('#amily2_pf_name').val().trim();
    const provider = $c.find('#amily2_pf_provider').val();
    const apiUrl   = $c.find('#amily2_pf_url').val().trim();
    const apiKey   = inheritsConnection ? '' : $c.find('#amily2_pf_key').val();
    const $sel = $c.find('#amily2_pf_model_select');
    const model = ($sel.is(':visible') ? $sel.val() : $c.find('#amily2_pf_model').val()).trim();

    if (!name) { toastr.warning(t('apiTableUi.api.nameRequired')); return; }

    const data = {
        type,
        name,
        model,
        rpm: $c.find('#amily2_pf_rpm').val(),
    };
    if (!inheritsConnection) {
        data.provider = provider;
        data.apiUrl = apiUrl;
    }

    if (type === 'chat') {
        data.maxTokens   = parseInt($c.find('#amily2_pf_max_tokens').val(), 10) || 65500;
        data.temperature = parseFloat($c.find('#amily2_pf_temperature').val()) || 1.0;
        data.fakeStream  = $c.find('#amily2_pf_fake_stream').prop('checked');

        // customParams：JSON 校验失败则中止保存
        const cp = _parseCustomParamsOrFail($c);
        if (cp === null) {
            toastr.error(t('apiTableUi.api.jsonSaveFailed'), t('apiTableUi.api.saveAborted'));
            return;
        }
        data.customParams = cp;
    } else if (type === 'embedding') {
        const dim = $c.find('#amily2_pf_dimensions').val();
        data.dimensions     = dim ? parseInt(dim, 10) : null;
        data.encodingFormat = $c.find('#amily2_pf_encoding_format').val();
    } else if (type === 'rerank') {
        data.topN            = parseInt($c.find('#amily2_pf_top_n').val(), 10) || 5;
        data.returnDocuments = $c.find('#amily2_pf_return_documents').is(':checked');
    }

    const $btn = $c.find('#amily2_profile_modal_save').prop('disabled', true);

    try {
        let profileId;
        if (_editingId) {
            apiProfileManager.updateProfile(_editingId, data);
            profileId = _editingId;
        } else {
            profileId = apiProfileManager.createProfile(data);
        }

        // 保存 Key（非空才写入）
        if (apiKey) {
            await apiProfileManager.setKey(profileId, apiKey);
        }

        closeModal($c);
        renderProfileList($c);
        renderSlotAssignments($c);
        toastr.success(t('apiTableUi.api.saved', { name }));
    } catch (e) {
        console.error('[ApiConfig] 保存 Profile 失败:', e);
        toastr.error(t('apiTableUi.api.saveFailed'));
    } finally {
        $btn.prop('disabled', false);
    }
}

// ── 获取模型 / 测试连接 ───────────────────────────────────────────────────────

async function _fetchModels($c) {
    const apiUrl   = $c.find('#amily2_pf_url').val().trim();
    const provider = $c.find('#amily2_pf_provider').val();

    // 编辑模式下 Key 不回显，字段为空时从 ApiKeyStore 读取已存储的 Key
    let apiKey = $c.find('#amily2_pf_key').val().trim();
    if (!apiKey && _editingId) {
        apiKey = await apiProfileManager.getKey(_editingId) ?? '';
    }

    if (!apiUrl) { toastr.warning(t('apiTableUi.api.addressRequired')); return; }

    const $btn = $c.find('#amily2_pf_fetch_models').prop('disabled', true);
    $btn.html(`<i class="fas fa-spinner fa-spin"></i> ${apiTableHtml('apiTableUi.api.fetching')}`);

    try {
        let models;

        if (provider === 'google') {
            // Google 用原生 API，Key 通过 x-goog-api-key 头传递避免 URL 泄露
            if (!apiKey) { toastr.warning(t('apiTableUi.api.googleKeyRequired')); return; }
            const resp = await fetch(
                'https://generativelanguage.googleapis.com/v1beta/models',
                { headers: { 'x-goog-api-key': apiKey } }
            );
            if (!resp.ok) {
                const status = resp.status;
                toastr.error(status === 400 ? t('apiTableUi.api.fetchFailed', { error: t('apiTableUi.api.keyInvalidFormat') })
                           : status === 403 ? t('apiTableUi.api.fetchFailed', { error: t('apiTableUi.api.keyUnauthorized') })
                           : t('apiTableUi.api.fetchFailed', { error: `HTTP ${status}` }));
                return;
            }
            const data = await resp.json();
            // 只保留支持文本生成的模型
            models = (data.models ?? [])
                .filter(m => m.supportedGenerationMethods?.some(
                    method => ['generateContent', 'embedContent'].includes(method)
                ))
                .map(m => m.name.replace(/^models\//, ''));
        } else {
            // OpenAI 兼容接口 — 通过 ST 后端代理，规避 CORS
            const resp = await fetch('/api/backends/chat-completions/status', {
                method: 'POST',
                headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    reverse_proxy: apiUrl,
                    proxy_password: apiKey,
                    chat_completion_source: 'openai',
                }),
            });
            if (!resp.ok) {
                const status = resp.status;
                if (status === 401 || status === 403) {
                    toastr.error(t('apiTableUi.api.fetchFailed', { error: t('apiTableUi.api.keyUnauthorized') }));
                } else if (status === 404) {
                    toastr.warning(t('apiTableUi.api.modelsUnsupported'));
                } else {
                    toastr.error(t('apiTableUi.api.fetchFailed', { error: `HTTP ${status}` }));
                }
                return;
            }
            const rawData = await resp.json();
            // ST 返回原始数组或包含 data/models 字段的对象
            const rawList = Array.isArray(rawData) ? rawData : (rawData.data ?? rawData.models ?? []);
            const list = Array.isArray(rawList) ? rawList : [];
            models = list.map(m => m.id ?? m.name ?? m).filter(m => typeof m === 'string' && m);
        }

        if (models.length === 0) {
            toastr.warning(t('apiTableUi.api.modelsEmpty'));
            return;
        }

        models.sort((a, b) => a.localeCompare(b));

        const currentVal = $c.find('#amily2_pf_model').val().trim();
        const $sel = $c.find('#amily2_pf_model_select');
        $sel.html(models.map(m => `<option value="${_escapeHtml(m)}">${_escapeHtml(m)}</option>`).join(''));
        if (currentVal && models.includes(currentVal)) $sel.val(currentVal);
        $c.find('#amily2_pf_model').hide();
        $sel.show();

        toastr.success(t('apiTableUi.api.modelsFetched', { count: models.length }));
    } catch (e) {
        toastr.error(t('apiTableUi.api.fetchFailed', { error: _apiErrorText(e) }));
    } finally {
        $btn.prop('disabled', false).html(`<i class="fas fa-list"></i> ${apiTableHtml('apiTableUi.api.fetch')}`);
    }
}

async function _testConnection($c) {
    const apiUrl   = $c.find('#amily2_pf_url').val().trim();
    const provider = $c.find('#amily2_pf_provider').val();

    // 编辑模式下 Key 不回显，字段为空时从 ApiKeyStore 读取已存储的 Key
    let apiKey = $c.find('#amily2_pf_key').val().trim();
    if (!apiKey && _editingId) {
        apiKey = await apiProfileManager.getKey(_editingId) ?? '';
    }

    // An existing profile must share the exact same limiter bucket as every
    // feature slot using it. Use only its persisted ID/RPM; unsaved form values
    // must not be able to loosen the limit. A new profile has no stable ID yet,
    // so its one-off connection test remains unlimited until the profile is saved.
    const savedProfile = _editingId ? apiProfileManager.getProfile(_editingId) : null;
    const rateLimitSettings = savedProfile
        ? bindSlotProfileRateLimit({}, savedProfile)
        : null;

    if (!apiUrl) { toastr.warning(t('apiTableUi.api.addressRequired')); return; }

    const $btn    = $c.find('#amily2_pf_test_conn').prop('disabled', true);
    const $result = setApiTableText($c.find('#amily2_pf_test_result'), 'apiTableUi.api.testing').css('color', 'var(--SmartThemeQuoteColor)');
    $btn.html(`<i class="fas fa-spinner fa-spin"></i> ${apiTableHtml('apiTableUi.api.testing')}`);

    try {
        if ($c.find('#amily2_pf_type').val() === 'embedding') {
            const $modelSelect = $c.find('#amily2_pf_model_select');
            const model = ($modelSelect.is(':visible') ? $modelSelect.val() : $c.find('#amily2_pf_model').val()).trim();
            if (!model) throw new Error(t('apiTableUi.api.embeddingRequired'));
            const settings = {
                apiEndpoint: embeddingEndpointForProvider(provider),
                customApiUrl: apiUrl, apiKey, embeddingModel: model, batchSize: 1,
            };
            const vectors = await getEmbeddings(['连接测试'], null,
                savedProfile ? bindSlotProfileRateLimit(settings, savedProfile) : settings);
            if (!Array.isArray(vectors[0]) || !vectors[0].length || !vectors[0].every(Number.isFinite)) {
                throw new Error(t('apiTableUi.api.embeddingInvalid'));
            }
            setApiTableText($result, 'apiTableUi.api.embeddingSuccess', { count: vectors[0].length }).css('color', 'var(--green)');
            toastr.success(t('apiTableUi.api.embeddingPassed'));
            return;
        }
        if (provider === 'google') {
            // Google 用原生 models 端点测试
            if (!apiKey) {
                setApiTableText($result, 'apiTableUi.api.keyRequired').css('color', 'var(--warning-color)');
                return;
            }
            const resp = await fetch(
                'https://generativelanguage.googleapis.com/v1beta/models',
                { headers: { 'x-goog-api-key': apiKey } }
            );
            if (resp.ok) {
                const data  = await resp.json();
                const count = (data.models ?? []).length;
                setApiTableText($result, count ? 'apiTableUi.api.connectedModels' : 'apiTableUi.api.connected', { count }).css('color', 'var(--green)');
                toastr.success(t('apiTableUi.api.googlePassed'));
            } else {
                const status = resp.status;
                const message = () => status === 400 ? t('apiTableUi.api.keyInvalidFormat')
                          : status === 403 ? t('apiTableUi.api.keyUnauthorized')
                          : `HTTP ${status}`;
                setApiTableText($result, 'apiTableUi.api.failed', () => ({ error: message() })).css('color', 'var(--warning-color)');
                toastr.error(t('apiTableUi.api.testFailed', { error: message() }));
            }
            return;
        }

        // OpenAI 兼容接口 — 通过 ST 后端代理，规避 CORS
        const modelsResp = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                reverse_proxy: apiUrl,
                proxy_password: apiKey,
                chat_completion_source: 'openai',
            }),
        });

        if (modelsResp.ok) {
            const rawData = await modelsResp.json();
            const rawList = Array.isArray(rawData) ? rawData : (rawData.data ?? rawData.models ?? []);
            const list    = Array.isArray(rawList) ? rawList : [];
            const count   = list.length;

            // chat 类型额外发一次假补全，验证 completion 端点也能正常鉴权
            const type  = $c.find('#amily2_pf_type').val();
            const $sel  = $c.find('#amily2_pf_model_select');
            const model = ($sel.is(':visible') ? $sel.val() : $c.find('#amily2_pf_model').val()).trim();

            if (type === 'chat' && model) {
                setApiTableText($result, 'apiTableUi.api.verifyingCompletion').css('color', 'var(--SmartThemeQuoteColor)');
                await acquireProfileRequestPermit(rateLimitSettings);
                const officialDeepSeek = isOfficialDeepSeekEndpoint(apiUrl);
                const useStream = $c.find('#amily2_pf_fake_stream').prop('checked') === true;
                const genResp = await fetch('/api/backends/chat-completions/generate', {
                    method: 'POST',
                    headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        reverse_proxy:          apiUrl,
                        proxy_password:         apiKey,
                        chat_completion_source: officialDeepSeek ? 'deepseek' : 'openai',
                        model,
                        messages:   [{ role: 'user', content: 'Hi' }],
                        // Newer reasoning/coding models commonly reject a one-token
                        // completion budget. Keep the probe small enough for a test,
                        // but large enough to exercise the real completion path.
                        max_tokens: 8192,
                        stream:     useStream,
                        ...(officialDeepSeek ? { include_reasoning: false } : {}),
                    }),
                });
                const genData = await readOpenAICompatibleResponse(genResp, {
                    stream: useStream,
                }).catch(() => ({}));
                if (!genResp.ok || genData?.error) {
                    const genErr = genData;
                    const errorKey = _knownApiErrorKey(genErr?.error);
                    const message = () => errorKey ? t(errorKey) : t('apiTableUi.api.completionHttp', { status: genResp.status });
                    setApiTableText($result, 'apiTableUi.api.completionFailed', () => ({ error: message() })).css('color', 'var(--warning-color)');
                    toastr.warning(t('apiTableUi.api.completionTestFailed', { error: message() }));
                    return;
                }
            }

            setApiTableText($result, count ? 'apiTableUi.api.connectedModels' : 'apiTableUi.api.connected', { count }).css('color', 'var(--green)');
            toastr.success(t('apiTableUi.api.passed'));
            return;
        }

        const status = modelsResp.status;
        const errBody = await modelsResp.json().catch(() => ({}));
        const errorKey = _knownApiErrorKey(errBody?.error);
        const message = () => errorKey ? t(errorKey)
                 : (status === 401 || status === 403 ? t('apiTableUi.api.keyUnauthorized')
                   : status === 404 ? t('apiTableUi.api.endpointMissing')
                   : `HTTP ${status}`);
        setApiTableText($result, 'apiTableUi.api.failed', () => ({ error: message() })).css('color', 'var(--warning-color)');
        toastr.error(t('apiTableUi.api.testFailed', { error: message() }));
    } catch (e) {
        const errorKey = _knownApiErrorKey(e) || 'apiTableUi.vault.unknownError';
        setApiTableText($result, 'apiTableUi.api.cannotConnect', () => ({ error: t(errorKey) })).css('color', 'var(--warning-color)');
        toastr.error(t('apiTableUi.api.connectionFailed', { error: t(errorKey) }));
    } finally {
        $btn.prop('disabled', false).html(`<i class="fas fa-plug"></i> ${apiTableHtml('apiTableUi.api.testConnection')}`);
    }
}

// ── Provider 切换 ─────────────────────────────────────────────────────────────

/**
 * 6 个享受 defaultUrl 自动填充的 vendor preset id。registry 之外的 provider
 * （sillytavern_backend / sillytavern_preset / custom_oai）走各自的特殊逻辑。
 */
const VENDOR_PRESETS = new Set(['anthropic', 'openai', 'google', 'openrouter', 'deepseek', 'xai']);

/**
 * 处理 provider 变化的"展示侧"逻辑：URL row 可见性 + vendor 提示框。
 * 不修改 URL 输入值（避免编辑现有 profile 时被覆盖）。
 * URL 自动填充由 _autofillVendorUrl 单独负责，仅在用户主动 change 时触发。
 */
async function _handleProviderChange($c, provider) {
    const $urlRow   = $c.find('#amily2_pf_url_row');
    const $note     = $c.find('#amily2_pf_vendor_note');
    const $noteText = $c.find('#amily2_pf_vendor_note_text');
    const $linkWrap = $c.find('#amily2_pf_vendor_note_link_wrap');
    const $link     = $c.find('#amily2_pf_vendor_note_link');

    // URL row 一律可见（包括 preset vendor —— 用户可能要切到代理/镜像）
    $urlRow.show();

    if (VENDOR_PRESETS.has(provider)) {
        try {
            const entry = await getVendorEntry(provider);
            if (entry) {
                setApiTableText($noteText, 'apiTableUi.api.vendorNote', { name: entry.displayName });
                if (entry.doc) {
                    setApiTableText($link.attr('href', entry.doc), 'apiTableUi.api.officialDocs');
                    $linkWrap.show();
                } else {
                    $linkWrap.hide();
                }
                $note.show();
                return;
            }
        } catch (e) {
            console.warn('[ApiConfig] vendor entry 加载失败:', e);
        }
    }
    $note.hide();
}

/**
 * 用户主动切换 provider 时，把 URL 字段写为该 vendor 的 defaultUrl。
 * Custom 模式清空 URL；ST backend/preset 不动 URL。
 * 同时刷新 customParams hint 与校验状态。
 */
async function _autofillVendorUrl($c, provider) {
    if (provider === 'custom_oai') {
        $c.find('#amily2_pf_url').val('');
        _updateCustomParamsHint($c);
        return;
    }
    if (!VENDOR_PRESETS.has(provider)) {
        // sillytavern_backend / sillytavern_preset 等不修改 URL
        return;
    }
    try {
        const entry = await getVendorEntry(provider);
        if (entry?.defaultUrl) {
            $c.find('#amily2_pf_url').val(entry.defaultUrl);
            _updateCustomParamsHint($c);
        }
    } catch (e) {
        console.warn('[ApiConfig] autofill defaultUrl 失败:', e);
    }
}

// ── 内部工具 ──────────────────────────────────────────────────────────────────

// Exact UI-boundary matches only: never interpolate an exception or response body.
const API_UI_ERROR_KEYS = new Map([
    ['Google直连模式需要API Key。', 'apiTableUi.vault.embeddingGoogleKeyRequired'],
    ['酒馆 Embedding 代理不可用（404）；请检查 enableCorsProxy 与反向代理路由。未回退前端直连。', 'apiTableUi.vault.embeddingProxyUnavailable'],
    ['API返回的向量数据格式不正确。', 'apiTableUi.vault.embeddingInvalidData'],
    ['获取到的向量数量与发送的文本数量不匹配。', 'apiTableUi.vault.embeddingCountMismatch'],
    ['Google embedding response has an invalid shape.', 'apiTableUi.vault.embeddingGoogleInvalidShape'],
    ['Embedding does not support chat preset forwarding.', 'apiTableUi.vault.embeddingPresetUnsupported'],
    ['Invalid embedding proxy URL.', 'apiTableUi.vault.embeddingProxyInvalid'],
]);

function _knownApiErrorKey(error) {
    const message = typeof error === 'string' ? error : error?.message;
    if (typeof message !== 'string') return null;
    const key = API_UI_ERROR_KEYS.get(message);
    if (key) return key;
    // These two errors originate in this UI and may predate a locale switch.
    for (const localKey of ['apiTableUi.api.embeddingRequired', 'apiTableUi.api.embeddingInvalid']) {
        if (['zh-CN-plain', 'zh-CN-amily', 'en-US'].some(locale => message === t(localKey, {}, locale))) return localKey;
    }
    return null;
}

function _apiErrorText(error) {
    return t(_knownApiErrorKey(error) || 'apiTableUi.vault.unknownError');
}

function _profileDeleteErrorText(error) {
    if (error?.code === 'PROFILE_CONNECTION_SOURCE_IN_USE'
        && Array.isArray(error.dependentProfileIds) && error.dependentProfileIds.length > 0) {
        return t('apiTableUi.vault.connectionInUse', { count: error.dependentProfileIds.length });
    }
    return t('apiTableUi.api.deleteFailed');
}

function _legacyCleanupErrorText(error) {
    if (!error) return t('apiTableUi.vault.legacyUnknown');
    if (error === 'extension_settings 不存在') return t('apiTableUi.vault.legacySettingsMissing');
    for (const slot of ['main', 'plotOpt', 'plotOptConc', 'ngms', 'nccs', 'sybd', 'cwb']) {
        if (error === `槽位 "${slot}" 仍有旧配置但未分配 profile，清除会导致该模块不可用。请先在 API 连接配置面板为它分配 profile。`) {
            return t('apiTableUi.vault.legacySlotUnassigned', { slot });
        }
    }
    if (error === '槽位 "autoCharCard" 仍有旧配置但未分配 profile，清除会导致一键生卡不可用。请先在 API 连接配置面板为它分配 profile。') {
        return t('apiTableUi.vault.legacyAutoCardUnassigned');
    }
    return t('apiTableUi.vault.unknownError');
}

function _switchParamSections($c, type) {
    $c.find('#amily2_pf_chat_params').toggle(type === 'chat');
    $c.find('#amily2_pf_embedding_params').toggle(type === 'embedding');
    $c.find('#amily2_pf_rerank_params').toggle(type === 'rerank');
}

function _truncateUrl(url) {
    try {
        const u = new URL(url);
        return u.host + (u.pathname.length > 1 ? u.pathname : '');
    } catch {
        return url.slice(0, 30);
    }
}

function _escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function _getCustomParamsEditorState($c) {
    const raw = ($c.find('#amily2_pf_custom_params').val() || '').trim();
    if (!raw) {
        return { valid: true, parsed: {}, empty: true };
    }

    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
            return { valid: false, parsed: null, empty: false };
        }
        return { valid: true, parsed, empty: false };
    } catch {
        return { valid: false, parsed: null, empty: false };
    }
}

function _getDefaultValueForParamType(type) {
    const normalized = String(type || '').toLowerCase();
    if (normalized.includes('array')) return [];
    if (normalized.includes('object')) return {};
    if (normalized.includes('integer') || normalized.includes('number')) return 0;
    if (normalized.includes('boolean')) return false;
    return '';
}

// ── customParams 辅助 ────────────────────────────────────────────────────────

/**
 * 根据当前 URL 输入识别 vendor，并把已知参数列表渲染到 hint 行。
 * registry 还没异步加载完时（detectVendorSync 返回 null）静默跳过。
 */
function _updateCustomParamsHint($c) {
    const $hint = $c.find('#amily2_pf_custom_params_hint');
    if (!$hint.length) return;

    const apiUrl = $c.find('#amily2_pf_url').val()?.trim() || '';
    const vendorId = detectVendorSync(apiUrl);
    if (!vendorId) {
        $hint.empty();
        return;
    }

    const params = listVendorParamsSync(vendorId);
    if (!params.length) {
        $hint.empty();
        return;
    }

    const editorState = _getCustomParamsEditorState($c);
    getVendorEntry(vendorId).then(entry => {
        const label = entry?.displayName || vendorId;
        const disabledAttr = editorState.valid ? '' : ' disabled';
        const buttons = params.map(param => `
            <button type="button"
                    class="menu_button small_button amily2_param_hint_btn"
                    data-param-name="${_escapeHtml(param.name)}"
                    data-param-type="${_escapeHtml(param.type || '')}"
                    style="margin:2px 6px 2px 0;"
                    ${disabledAttr}>${_escapeHtml(param.name)}</button>
        `).join('');
        const invalidNote = editorState.valid
            ? ''
            : `<span style="margin-left:6px; color:var(--warning, #d9534f);">${apiTableHtml('apiTableUi.api.fixJson')}</span>`;
        $hint.html(`${apiTableHtml('apiTableUi.api.knownParams', { name: label })} ${buttons}${invalidNote}`);
    });
}

/**
 * 实时校验 customParams 文本框内容。空 / 合法 JSON object → 清空错误。
 * 非 JSON 或非 object → 在 #_error 行显示。仅做提示，不阻断输入。
 */
function _validateCustomParamsLive($c) {
    const $err = $c.find('#amily2_pf_custom_params_error');
    if (!$err.length) return;

    const state = _getCustomParamsEditorState($c);
    if (state.empty) {
        $err.hide().text('');
        return;
    }
    if (state.valid) {
        $err.hide().text('');
        return;
    }
    try {
        JSON.parse(($c.find('#amily2_pf_custom_params').val() || '').trim());
        setApiTableText($err.show(), 'apiTableUi.api.jsonObjectRequired');
    } catch {
        setApiTableText($err.show(), 'apiTableUi.vault.invalidCustomJson');
    }
}

function _insertParamToCustomParams($c, paramName, paramType) {
    const state = _getCustomParamsEditorState($c);
    if (!state.valid) return;

    const next = { ...(state.parsed || {}) };
    if (Object.prototype.hasOwnProperty.call(next, paramName)) {
        return;
    }

    next[paramName] = _getDefaultValueForParamType(paramType);
    $c.find('#amily2_pf_custom_params').val(JSON.stringify(next, null, 2));
    _validateCustomParamsLive($c);
    _updateCustomParamsHint($c);
}

/**
 * 清除旧配置残留 —— 二次确认 → 调 clearLegacyConfig → 反馈结果。
 */
async function _handleClearLegacyConfig($c) {
    const confirmed = window.confirm(t('apiTableUi.vault.legacyConfirm'));
    if (!confirmed) return;

    try {
        const result = await clearLegacyConfig();
        if (!result.ok) {
            toastr.error(_legacyCleanupErrorText(result.error), t('apiTableUi.vault.legacyBlocked'));
            return;
        }
        toastr.success(
            t('apiTableUi.vault.legacyCleared', { fields: result.clearedFields, keys: result.clearedKeys }),
            t('apiTableUi.vault.legacyComplete'),
            { timeOut: 6000 }
        );
    } catch (e) {
        console.error('[ApiConfig] 清除旧配置失败:', e);
        toastr.error(t('apiTableUi.vault.legacyFailed', { error: _apiErrorText(e) }), t('apiTableUi.vault.errorTitle'));
    }
}

/**
 * saveProfile 调用：解析 customParams 文本，失败返回 null（调用方中止保存）。
 * 空文本视为空对象 {}。
 *
 * @returns {Object | null}
 */
function _parseCustomParamsOrFail($c) {
    const state = _getCustomParamsEditorState($c);
    return state.valid ? (state.parsed || {}) : null;
}
