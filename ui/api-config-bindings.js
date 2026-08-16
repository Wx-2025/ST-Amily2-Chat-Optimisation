/**
 * api-config-bindings.js — API 连接配置面板 UI 事件绑定
 *
 * 依赖：
 *   ApiProfileManager（数据层）
 *   ApiKeyStore（密钥存储）
 */

import { apiProfileManager, PROFILE_TYPES, SLOTS, clearLegacyConfig } from '../utils/config/ApiProfileManager.js';
import { apiKeyStore, CloudTransitionError } from '../utils/config/api-key-store/ApiKeyStore.js';
import {
    clearVaultDeviceKey,
    discardVaultEncryptedState,
    disableVaultSync,
    enableVaultSync,
    getVaultSyncStatus,
    reconcileVaultSync,
    subscribeVaultSyncStatus,
} from '../utils/config/api-key-store/vault-sync-controller.js';
import { configManager } from '../utils/config/ConfigManager.js';
import { getRequestHeaders, saveSettingsDebounced } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { extensionName, extensionBasePath } from '../utils/settings.js';
import { testApiConnection } from '../core/api.js';
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
    // 向量化 / 重排共用翰林院「启用智能检索」总开关
    ragEmbed:     { key: 'hanlinyuan-rag-core.retrieval.enabled',         checkbox: '#hly-retrieval-enabled' },
    ragRerank:    { key: 'hanlinyuan-rag-core.retrieval.enabled',         checkbox: '#hly-retrieval-enabled' },
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
          showContentModal('API 连接使用教程', `${extensionBasePath}/ApiConfig.md`, {
              advancedTitle: 'API 连接 · 进阶操作',
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
}

// ── 存储模式 ──────────────────────────────────────────────────────────────────

const VAULT_STATUS_COPY = Object.freeze({
    disabled: Object.freeze({ badge: '已关闭', message: '授权码云同步已关闭。' }),
    unavailable: Object.freeze({ badge: '不可用', message: '当前授权不支持此功能，请使用有效的 Type2 或以上服务器授权。' }),
    idle: Object.freeze({ badge: '待同步', message: '授权码云同步已启用，尚未检查云端密钥。' }),
    checking: Object.freeze({ badge: '检查中', message: '正在安全检查本机与云端密钥，请稍候。' }),
    'migration-pending': Object.freeze({ badge: '正在迁移', message: '正在准备本机密钥并启用授权码云同步，请稍候。' }),
    'recovery-pending': Object.freeze({ badge: '等待恢复', message: '云端密钥可用，正在等待安全恢复到此设备。' }),
    'cleanup-pending': Object.freeze({ badge: '正在切换', message: '正在安全结束授权码云同步并切换存储模式。' }),
    'remote-empty': Object.freeze({ badge: '云端为空', message: '云端暂无密钥；立即同步可将本机密钥加密备份。' }),
    synced: Object.freeze({ badge: '已同步', message: '本机与云端密钥已同步。' }),
    restored: Object.freeze({ badge: '已恢复', message: '已从授权码云端恢复此设备的私钥。' }),
    conflict: Object.freeze({ badge: '需要选择', message: '本机与云端指纹不同，已暂停同步。请明确选择要保留的一份。' }),
    error: Object.freeze({ badge: '同步失败', message: '云密钥服务暂不可用，本机密钥未改动。' }),
});
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
    return Object.freeze({
        enabled: raw.enabled === true,
        status,
        revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
        fingerprint,
        canUseRemote: raw.canUseRemote === true,
        canOverwriteRemote: raw.canOverwriteRemote === true,
        canDiscardEncrypted: raw.canDiscardEncrypted === true,
        canClearDeviceKey: raw.canClearDeviceKey === true,
    });
}

function _renderVaultSyncStatus($c, snapshot = getVaultSyncStatus()) {
    const state = _normalizeVaultSyncStatus(snapshot);
    const copy = VAULT_STATUS_COPY[state.status];
    const busy = [
        'checking',
        'migration-pending',
        'cleanup-pending',
    ].includes(state.status);
    const canClearDeviceKey = ['synced', 'restored'].includes(state.status)
        && state.canClearDeviceKey;
    const $syncButton = $c.find('#amily2_vault_sync_now');

    $c.find('#amily2_keystore_mode').prop('disabled', busy);
    $c.find('#amily2_vault_sync_badge')
        .attr('data-state', state.status)
        .text(copy.badge);
    $c.find('#amily2_vault_sync_status').text(copy.message);
    $c.find('#amily2_vault_sync_revision')
        .prop('hidden', state.revision === 0 && !state.fingerprint)
        .text([
            state.revision > 0 ? `云端修订：${state.revision}` : '',
            state.fingerprint ? `指纹：${state.fingerprint}` : '',
        ].filter(Boolean).join(' · '));

    $syncButton.prop('disabled', busy || !state.enabled);
    $syncButton.find('.vbtn-icon i').toggleClass('fa-spin', busy);
    $syncButton.find('.vbtn-label').text(busy ? '正在同步' : '立即同步');
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
        '#amily2_keystore_mode',
    ].join(',')).prop('disabled', true);
    try {
        const snapshot = await action();
        const state = _normalizeVaultSyncStatus(snapshot);
        _renderVaultSyncStatus($c, state);
        if (options.successMessage && successStatuses.includes(state.status)) {
            toastr.success(options.successMessage);
        }
        return state;
    } catch {
        // Vault exceptions may carry transport details. Keep credentials and remote
        // responses out of the DOM/toast and let the controller publish safe status.
        console.warn('[ApiConfig] 授权码云同步操作失败。');
        _renderVaultSyncStatus($c);
        toastr.error('云密钥操作失败，本机数据未被清除。请稍后重试。');
        return null;
    }
}

const MANUAL_CLOUD_RECOVERY_COPY = Object.freeze({
    'needs-import': '检测到已有共享加密配置，但本设备缺少匹配私钥。请先导入原私钥；共享备份与本机配置均未改动。',
    ready: '原私钥已就绪。请重新选择“加密云同步”，插件会再次检查后再切换。',
    conflict: '原私钥已就绪，但本机与共享云端配置不同。请重新选择“加密云同步”并明确采用哪一份。',
    invalid: '检测到共享加密配置无法通过完整性检查。请尝试导入原私钥后重试；共享备份与本机配置均未改动。',
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
    $c.find('#amily2_manual_cloud_recovery_status').text(copy);
    $c.find('#amily2_manual_cloud_recovery').prop('hidden', false);
}

function _hideManualCloudRecovery($c) {
    $c.find('#amily2_manual_cloud_recovery').prop('hidden', true);
}

function _chooseManualCloudConflictStrategy() {
    const useRemote = confirm(
        '检测到本机与共享云端的 API 密钥不同。\n\n'
        + '“确定”：采用云端配置。\n'
        + '“取消”：继续选择“用本机覆盖”或“取消切换”。',
    );
    if (useRemote) return 'use-cloud';

    const overwriteRemote = confirm(
        '是否用本机覆盖共享云端备份？这会影响其他使用该共享备份的设备。\n\n'
        + '“确定”：用本机覆盖共享云端备份。\n'
        + '“取消”：取消切换，不改动本机或共享备份。',
    );
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
        local: '本机存储：密钥只在当前浏览器，不会上传。换设备要重新填。',
        cloud: '加密云同步：密钥随设置同步，私钥需手动导入或导出。',
        vault: '授权码云同步：Type2 及以上可加密备份私钥，并在新设备恢复。',
    };

    const renderMode = mode => {
        $select.val(mode);
        $cloud.toggle(mode === 'cloud' || mode === 'vault');
        $vault.prop('hidden', mode !== 'vault');
        $note.text(MODE_NOTES[mode] || MODE_NOTES.local);
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
                ? '切换回本机存储：\n已加密的 Key 将解密迁移至本机，并停止授权码云同步。服务器备份不会被删除。\n\n确认切换？'
                : '仅本设备退出加密云同步：\n密钥会在本设备解密保存；共享加密备份及私钥不会删除，其他设备不受影响。\n\n确认切换？',
            cloud: previousMode === 'vault'
                ? '切换到手动私钥模式：\n将停止授权码云同步，服务器备份不会被删除。以后换设备需手动导入私钥。\n\n确认切换？'
                : '切换到加密云同步模式：\n插件会先检查共享配置；仅在没有共享配置时生成密钥对。\n\n确认切换？',
            vault: '切换到授权码云同步：\n仅 Type2 及以上服务器授权可用。插件会检查云端密钥；若指纹冲突，将等待你手动选择。\n\n确认切换？',
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
                toastr.warning(MANUAL_CLOUD_RECOVERY_COPY[manualCloudState]);
                return;
            }
            _hideManualCloudRecovery($c);
            if (manualCloudState === 'conflict') {
                manualCloudStrategy = _chooseManualCloudConflictStrategy();
                if (!manualCloudStrategy) {
                    renderMode(previousMode);
                    return;
                }
            } else if (!confirm(confirmations.cloud)) {
                renderMode(previousMode);
                return;
            }
        } else if (!confirm(confirmations[newMode])) {
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
                    successMessage: '授权码云同步已启用。',
                },
            );
            if (state && ['error', 'unavailable', 'remote-empty'].includes(state.status)) {
                toastr.warning('授权码云同步尚未启用，请根据状态提示重试或检查授权。');
            }
            // A fingerprint conflict deliberately does not commit Vault mode.
            // Keep the pending panel visible so the user can make the explicit
            // choice; a reload safely returns to the previously committed mode.
            const pendingState = state && !['synced', 'restored'].includes(state.status);
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
                    successMessage: '授权码云同步已关闭。',
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
            const modeName = newMode === 'vault'
                ? '授权码云同步'
                : newMode === 'cloud' ? '加密云同步' : '本机存储';
            toastr.success(`已切换为${modeName}模式。`);
        } catch {
            console.warn('[ApiConfig] 密钥存储模式切换失败。');
            toastr.error('模式切换失败，本机密钥与共享备份均未改动。');
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
                successMessage: '云密钥同步完成。',
            },
        ));

    $c.find('#amily2_vault_use_remote')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`click${API_KEY_STORAGE_EVENT_NAMESPACE}`, () => {
        if (!confirm('采用云端密钥将替换此设备当前私钥。确认继续？')) return;
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
                successMessage: '已采用云端密钥。',
            },
        );
    });

    $c.find('#amily2_vault_use_local')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`click${API_KEY_STORAGE_EVENT_NAMESPACE}`, () => {
        const expectedRemote = _normalizeVaultSyncStatus(getVaultSyncStatus());
        const remoteIsEmpty = expectedRemote.revision === 0 && !expectedRemote.fingerprint;
        if (!confirm(remoteIsEmpty
            ? '用当前设备密钥初始化此授权的云端备份？此操作只会在云端仍为空时执行。'
            : '用本机覆盖云端会替换服务器上的密钥备份；与旧密钥对应的同步密文也可能无法再恢复，其他设备需要重新同步。确认继续？')) return;
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
                successMessage: '已用本机密钥更新云端备份。',
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
                toastr.warning('仅当本机与云端密钥确认一致后，才能清除此设备密钥。');
                return;
            }
            if (!confirm('只清除此设备保存的私钥？已确认云端存在匹配备份；已加密的 API Key 不会删除，之后需再次恢复私钥才能使用。')) return;
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
            if (!confirm('确认放弃此设备当前无法恢复的全部加密 API Key？\n\n这会清除同步密文和本机回退，切换为空的本机存储；服务器上的密钥备份不会删除。此操作不可撤销。')) return;
            try {
                const result = await discardVaultEncryptedState();
                if (!result || result.status !== 'disabled') {
                    _renderVaultSyncStatus($c, result);
                    return;
                }
                renderMode('local');
                toastr.warning('已放弃无法恢复的密文并切换为空的本机存储。');
            } catch {
                toastr.error('清理失败，原加密配置已保留。');
            }
        });

    // 重新生成密钥对
    $c.find('#amily2_generate_keypair')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`click${API_KEY_STORAGE_EVENT_NAMESPACE}`, async () => {
        if (apiKeyStore.getMode() === 'vault') {
            toastr.info('请先切换到“加密云同步（手动私钥）”模式，再重新生成密钥对。');
            return;
        }
        let keyRotationInspection;
        try {
            keyRotationInspection = await apiKeyStore.inspectManualCloudState();
        } catch {
            toastr.error('无法确认共享加密备份状态，未重新生成密钥。');
            return;
        }
        const keyRotationState = _normalizeManualCloudState(keyRotationInspection);
        if (apiKeyStore.getMode() === 'local' && keyRotationState !== 'empty') {
            _showManualCloudRecovery($c, keyRotationState);
            toastr.warning('检测到共享加密备份，已阻止重新生成密钥。请先恢复或明确切换存储模式。');
            return;
        }
        if (apiKeyStore.getMode() === 'cloud'
            && (keyRotationState === 'needs-import' || keyRotationState === 'invalid')) {
            toastr.warning('当前设备无法验证共享加密备份，已阻止重新生成密钥。');
            return;
        }
        if (!confirm('重新生成密钥对后，所有已加密的 API Key 将失效，需要逐一重新输入。\n\n确认重新生成？')) return;
        try {
            await apiKeyStore.generateKeyPair({
                expectedRemoteToken: keyRotationInspection.remoteSnapshotToken,
                expectedLocalMutationRevision: keyRotationInspection.localMutationRevision,
            });
            await _refreshFingerprint($c);
            toastr.warning('新密钥对已生成，请重新输入各 Profile 的 API Key。');
        } catch {
            toastr.error('共享加密备份已变化或密钥重置失败，现有配置未改动。');
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
            toastr.success('私钥包已导出，请妥善保管。');
        } catch {
            console.warn('[ApiConfig] 导出私钥包失败。');
            toastr.error('导出私钥包失败，请确认本设备已有可用私钥。');
        }
    });

    $c.find('#amily2_manual_cloud_recovery_import')
        .off(API_KEY_STORAGE_EVENT_NAMESPACE)
        .on(`click${API_KEY_STORAGE_EVENT_NAMESPACE}`, async () => {
        if (apiKeyStore.getMode() !== 'local') {
            toastr.info('恢复入口仅用于本设备仍处于本机存储时导入原私钥。');
            return;
        }
        try {
            manualCloudImportInspection = await apiKeyStore.inspectManualCloudState();
        } catch {
            toastr.error('无法确认共享加密备份状态，未打开私钥文件。');
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
            toastr.info('请先切换到“加密云同步（手动私钥）”模式，再导入私钥。');
            return;
        }
        try {
            manualCloudImportInspection = await apiKeyStore.inspectManualCloudState();
        } catch {
            toastr.error('无法确认共享加密备份状态，未打开私钥文件。');
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
            toastr.info('请先切换到“加密云同步（手动私钥）”模式，再导入私钥。');
            return;
        }

        if (!manualCloudImportInspection) {
            try {
                manualCloudImportInspection = await apiKeyStore.inspectManualCloudState();
            } catch {
                $importInput.val('');
                toastr.error('无法确认共享加密备份状态，未导入私钥。');
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
                toastr.success('原私钥已导入；本设备仍保持本机存储，请重新选择云同步完成检查。');
            } else {
                await configManager.syncSensitiveCache({ force: true });
                _hideManualCloudRecovery($c);
                toastr.success('私钥包导入成功，已恢复本设备的加密密钥缓存。');
            }
        } catch {
            console.warn('[ApiConfig] 导入私钥包失败。');
            if (apiKeyStore.getMode() === 'local') {
                _showManualCloudRecovery($c, 'invalid');
            }
            toastr.error('导入私钥失败；本机配置与共享备份均未改动，请选择匹配的原私钥包。');
        } finally {
            manualCloudImportInspection = null;
            $importInput.val('');
        }
    });
}

async function _refreshFingerprint($c) {
    const fp = await apiKeyStore.getPublicKeyInfo();
    $c.find('#amily2_keypair_fingerprint').text(fp);
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
            '<p>还没有连接</p>' +
            '<small>点右上角「添加」开始</small>' +
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
        const typeInfo = PROFILE_TYPES[p.type] || { icon: 'fa-server', label: p.type || '未知' };
        const typeClass = TYPE_CLASS[p.type] || '';
        const selected = p.id === _editingId ? ' is-selected' : '';
        const sub = [
            typeInfo.label,
            p.model || '未设模型',
            p.apiUrl ? _truncateUrl(p.apiUrl) : '',
        ].filter(Boolean).join(' · ');
        return `
        <div class="amily2_profile_card am2-ac-row${selected}" data-id="${p.id}" role="button" tabindex="0">
            <span class="am2-ac-dot ${typeClass}" aria-hidden="true"></span>
            <div class="am2-ac-row-body">
                <div class="am2-ac-row-title">${_escapeHtml(p.name)}</div>
                <div class="am2-ac-row-sub">${_escapeHtml(sub)}</div>
            </div>
            <button class="am2-ac-iconbtn amily2_delete_profile" data-id="${p.id}" title="删除" type="button">
                <i class="fas fa-trash-alt"></i>
            </button>
            <i class="fas fa-chevron-right am2-ac-chevron" aria-hidden="true"></i>
        </div>`;
    }).join('');

    $list.html(html);

    // 整行点击进入编辑（删除按钮除外）
    $list.find('.am2-ac-row').on('click', function (e) {
        if ($(e.target).closest('.amily2_delete_profile').length) return;
        openModal($c, $(this).data('id'));
    });
    $list.find('.am2-ac-row').on('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openModal($c, $(this).data('id'));
        }
    });
    $list.find('.amily2_delete_profile').on('click', async function (e) {
        e.stopPropagation();
        const id   = $(this).data('id');
        const name = apiProfileManager.getProfile(id)?.name || id;
        if (!confirm(`删除「${name}」？密钥会一并清除。`)) return;
        try {
            await apiProfileManager.deleteProfile(id);
        } catch {
            toastr.error('密钥删除失败，Profile 未被移除。');
            return;
        }
        if (_editingId === id) closeModal($c);
        renderProfileList($c);
        renderSlotAssignments($c);
        toastr.success(`已删除「${name}」。`);
    });
}

// ── 功能槽分配渲染 ────────────────────────────────────────────────────────────

export function renderSlotAssignments($c) {
    const $slots = $c.find('#amily2_slot_assignments');

    const settings = extension_settings[extensionName] || {};

    // 按类型分组，减少一长串压迫感
    const groups = [
        { key: 'chat', title: '对话能力' },
        { key: 'embedding', title: '智能检索' },
        { key: 'rerank', title: '结果重排' },
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
                `<option value="">未分配</option>`,
                ...profiles.map(p =>
                    `<option value="${p.id}" ${p.id === assigned ? 'selected' : ''}>${_escapeHtml(p.name)}</option>`
                ),
            ].join('');

            const toggleHtml = toggle
                ? `<label class="toggle-switch am2-ac-switch" title="一键启用 / 关闭该功能">
                       <input type="checkbox" class="amily2_slot_toggle" data-slot="${slot}" ${_readSlotToggle(settings, toggle) ? 'checked' : ''} />
                       <span class="slider"></span>
                   </label>`
                : '';

            return `
            <div class="am2-ac-setting ${assigned ? 'is-on' : ''}">
                <div class="am2-ac-setting-label">
                    <strong>${_escapeHtml(slotInfo.label)}</strong>
                </div>
                <div class="am2-ac-setting-controls">
                    ${toggleHtml}
                    <select class="text_pole amily2_slot_select am2-ac-input am2-ac-input-sm" data-slot="${slot}">
                        ${options}
                    </select>
                    <button class="am2-ac-iconbtn amily2_slot_test" data-slot="${slot}"
                            title="测试" type="button" ${assigned ? '' : 'disabled'}>
                        <i class="fas fa-bolt"></i>
                    </button>
                </div>
            </div>`;
        }).join('');
        return `<div class="am2-ac-group"><h3 class="am2-ac-group-title">${g.title}</h3><div class="am2-ac-settings">${rows}</div></div>`;
    }).join('');

    $slots.html(html);

    $slots.find('.amily2_slot_select').on('change', function () {
        const slot = $(this).data('slot');
        const id   = $(this).val() || null;
        if (!apiProfileManager.setAssignment(slot, id)) {
            toastr.error('类型不匹配，分配失败。');
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
                toastr.warning('该槽位暂不支持快捷测试。', slot);
                return;
            }
            const profile = await apiProfileManager.getAssignedProfile(slot);
            if (!profile) {
                toastr.warning('该槽位未分配配置。', slot);
                return;
            }
            // 测试函数内部会显示 toastr 结果
            await testFn();
        } catch (e) {
            toastr.error(`测试失败：${e.message}`, slot);
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

        // 同一设置键可能对应多个槽（如 ragEmbed / ragRerank），同步其它开关 UI
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
}

async function openModal($c, id) {
    _switchAcTab($c, 'connections', { keepForm: true });
    _editingId = id;

    if (id) {
        const p = apiProfileManager.getProfile(id);
        if (!p) return;
        $c.find('#amily2_profile_modal_title').text(p.name || '编辑连接');
        $c.find('#amily2_profile_form_icon').attr('class', 'fas fa-edit');
        $c.find('#amily2_pf_type').val(p.type).prop('disabled', true);
        $c.find('#amily2_pf_name').val(p.name);
        $c.find('#amily2_pf_provider').val(p.provider);
        $c.find('#amily2_pf_url').val(p.apiUrl);
        $c.find('#amily2_pf_key').val('');
        $c.find('#amily2_pf_model').val(p.model);
        $c.find('#amily2_pf_rpm').val(p.rpm ?? 0);

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
        $c.find('#amily2_profile_modal_title').text('添加连接');
        $c.find('#amily2_profile_form_icon').attr('class', 'fas fa-plus');
        $c.find('#amily2_pf_type').val('chat').prop('disabled', false);
        $c.find('#amily2_pf_name, #amily2_pf_url, #amily2_pf_key, #amily2_pf_model').val('');
        $c.find('#amily2_pf_provider').val('openai');
        _handleProviderChange($c, 'openai');
        _autofillVendorUrl($c, 'openai');
        $c.find('#amily2_pf_max_tokens').val(65500);
        $c.find('#amily2_pf_temperature').val(1.0);
        $c.find('#amily2_pf_rpm').val(0);
        $c.find('#amily2_pf_fake_stream').prop('checked', false);
        $c.find('#amily2_pf_custom_params').val('');
        $c.find('#amily2_pf_dimensions').val('');
        $c.find('#amily2_pf_encoding_format').val('float');
        $c.find('#amily2_pf_top_n').val(5);
        $c.find('#amily2_pf_return_documents').prop('checked', false);
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
    const type     = $c.find('#amily2_pf_type').val();
    const name     = $c.find('#amily2_pf_name').val().trim();
    const provider = $c.find('#amily2_pf_provider').val();
    const apiUrl   = $c.find('#amily2_pf_url').val().trim();
    const apiKey   = $c.find('#amily2_pf_key').val();
    const $sel = $c.find('#amily2_pf_model_select');
    const model = ($sel.is(':visible') ? $sel.val() : $c.find('#amily2_pf_model').val()).trim();

    if (!name) { toastr.warning('请填写配置名称。'); return; }

    const data = {
        type,
        name,
        provider,
        apiUrl,
        model,
        rpm: $c.find('#amily2_pf_rpm').val(),
    };

    if (type === 'chat') {
        data.maxTokens   = parseInt($c.find('#amily2_pf_max_tokens').val(), 10) || 65500;
        data.temperature = parseFloat($c.find('#amily2_pf_temperature').val()) || 1.0;
        data.fakeStream  = $c.find('#amily2_pf_fake_stream').prop('checked');

        // customParams：JSON 校验失败则中止保存
        const cp = _parseCustomParamsOrFail($c);
        if (cp === null) {
            toastr.error('自定义参数 JSON 解析失败，请修正后再保存。', '保存中止');
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
        toastr.success(`配置「${name}」已保存。`);
    } catch (e) {
        console.error('[ApiConfig] 保存 Profile 失败:', e);
        toastr.error('保存失败，请查看控制台。');
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

    if (!apiUrl) { toastr.warning('请先填写 API 地址。'); return; }

    const $btn = $c.find('#amily2_pf_fetch_models').prop('disabled', true);
    $btn.html('<i class="fas fa-spinner fa-spin"></i> 获取中...');

    try {
        let models;

        if (provider === 'google') {
            // Google 用原生 API，Key 通过 x-goog-api-key 头传递避免 URL 泄露
            if (!apiKey) { toastr.warning('请先填写 Google API Key。'); return; }
            const resp = await fetch(
                'https://generativelanguage.googleapis.com/v1beta/models',
                { headers: { 'x-goog-api-key': apiKey } }
            );
            if (!resp.ok) {
                const status = resp.status;
                toastr.error(status === 400 ? '获取失败：API Key 格式错误。'
                           : status === 403 ? '获取失败：API Key 无效或无权限。'
                           : `获取失败：HTTP ${status}`);
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
                    toastr.error('获取失败：API Key 无效或无权限。');
                } else if (status === 404) {
                    toastr.warning('该接口不支持模型列表查询，请手动填写模型 ID。');
                } else {
                    toastr.error(`获取失败：HTTP ${status}`);
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
            toastr.warning('未获取到模型列表，请手动填写。');
            return;
        }

        models.sort((a, b) => a.localeCompare(b));

        const currentVal = $c.find('#amily2_pf_model').val().trim();
        const $sel = $c.find('#amily2_pf_model_select');
        $sel.html(models.map(m => `<option value="${_escapeHtml(m)}">${_escapeHtml(m)}</option>`).join(''));
        if (currentVal && models.includes(currentVal)) $sel.val(currentVal);
        $c.find('#amily2_pf_model').hide();
        $sel.show();

        toastr.success(`已获取 ${models.length} 个可用模型。`);
    } catch (e) {
        toastr.error(`获取失败：${e.message}`);
    } finally {
        $btn.prop('disabled', false).html('<i class="fas fa-list"></i> 获取');
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

    if (!apiUrl) { toastr.warning('请先填写 API 地址。'); return; }

    const $btn    = $c.find('#amily2_pf_test_conn').prop('disabled', true);
    const $result = $c.find('#amily2_pf_test_result').text('测试中…').css('color', 'var(--SmartThemeQuoteColor)');
    $btn.html('<i class="fas fa-spinner fa-spin"></i> 测试中...');

    try {
        if (provider === 'google') {
            // Google 用原生 models 端点测试
            if (!apiKey) {
                $result.text('请填写 API Key').css('color', 'var(--warning-color)');
                return;
            }
            const resp = await fetch(
                'https://generativelanguage.googleapis.com/v1beta/models',
                { headers: { 'x-goog-api-key': apiKey } }
            );
            if (resp.ok) {
                const data  = await resp.json();
                const count = (data.models ?? []).length;
                $result.text(`连接成功${count ? `，${count} 个可用模型` : ''}`).css('color', 'var(--green)');
                toastr.success('Google AI Studio 连接测试通过！');
            } else {
                const status = resp.status;
                const msg = status === 400 ? 'API Key 格式错误'
                          : status === 403 ? 'API Key 无效或无权限'
                          : `HTTP ${status}`;
                $result.text(`失败：${msg}`).css('color', 'var(--warning-color)');
                toastr.error(`测试失败：${msg}`);
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
                $result.text('模型列表 ✓，正在验证补全端点…').css('color', 'var(--SmartThemeQuoteColor)');
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
                        max_tokens: 1,
                        stream:     useStream,
                        ...(officialDeepSeek ? { include_reasoning: false } : {}),
                    }),
                });
                const genData = await readOpenAICompatibleResponse(genResp, {
                    stream: useStream,
                }).catch(() => ({}));
                if (!genResp.ok || genData?.error) {
                    const genErr = genData;
                    const genMsg = genErr?.error?.message || `补全端点返回 HTTP ${genResp.status}`;
                    $result.text(`模型列表 ✓，补全失败：${genMsg}`).css('color', 'var(--warning-color)');
                    toastr.warning(`补全端点测试失败：${genMsg}`);
                    return;
                }
            }

            $result.text(`连接成功${count ? `，${count} 个可用模型` : ''}`).css('color', 'var(--green)');
            toastr.success('连接测试通过！');
            return;
        }

        const status = modelsResp.status;
        const errBody = await modelsResp.json().catch(() => ({}));
        const msg = errBody?.error?.message
                 || (status === 401 || status === 403 ? 'API Key 无效或无权限'
                   : status === 404 ? '接口地址不存在'
                   : `HTTP ${status}`);
        $result.text(`失败：${msg}`).css('color', 'var(--warning-color)');
        toastr.error(`测试失败：${msg}`);
    } catch (e) {
        $result.text(`无法连接：${e.message}`).css('color', 'var(--warning-color)');
        toastr.error(`连接失败：${e.message}`);
    } finally {
        $btn.prop('disabled', false).html('<i class="fas fa-plug"></i> 测试连接');
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
                $noteText.text(`${entry.displayName} — 默认接口地址已自动填写，如需走代理/镜像可在下方修改。`);
                if (entry.doc) {
                    $link.attr('href', entry.doc).text('查看官方文档');
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
            : '<span style="margin-left:6px; color:var(--warning, #d9534f);">请先修复 JSON，再插入参数。</span>';
        $hint.html(`${_escapeHtml(label)} 已知参数：${buttons}${invalidNote}`);
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
        $err.show().text('需要是 JSON 对象（{} 形式），不能是数组或基本类型。');
    } catch (e) {
        $err.show().text(`JSON 解析失败：${e.message}`);
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
    const confirmed = window.confirm(
        '【清除旧配置残留】\n\n' +
        '即将删除以下数据：\n' +
        '• extension_settings 中各模块的旧 URL / Model / 温度 / maxTokens / 模式等字段\n' +
        '• localStorage 中各模块的旧 API Key\n\n' +
        '⚠️ 操作不可恢复。如果某个槽位还没分配 profile，操作会被阻止。\n\n' +
        '确定继续吗？'
    );
    if (!confirmed) return;

    try {
        const result = await clearLegacyConfig();
        if (!result.ok) {
            toastr.error(result.error || '清除失败，未知错误。', '清除被阻止');
            return;
        }
        toastr.success(
            `已清除 ${result.clearedFields} 个旧字段、${result.clearedKeys} 个旧 API Key。建议刷新页面验证。`,
            '清除完成',
            { timeOut: 6000 }
        );
    } catch (e) {
        console.error('[ApiConfig] 清除旧配置失败:', e);
        toastr.error(`清除失败: ${e.message}`, '错误');
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
