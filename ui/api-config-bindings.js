/**
 * api-config-bindings.js — API 连接配置面板 UI 事件绑定
 *
 * 依赖：
 *   ApiProfileManager（数据层）
 *   ApiKeyStore（密钥存储）
 */

import { apiProfileManager, PROFILE_TYPES, SLOTS } from '../utils/config/ApiProfileManager.js';
import { apiKeyStore } from '../utils/config/api-key-store/ApiKeyStore.js';

// ── 状态 ─────────────────────────────────────────────────────────────────────

let _editingId      = null;   // 当前编辑的 Profile ID（null = 新建）
let _currentFilter  = 'all';  // 当前类型筛选

// ── 入口：绑定整个面板 ────────────────────────────────────────────────────────

export function bindApiConfigPanel(container) {
    const $c = $(container);

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

    // 弹窗：类型切换时显示/隐藏专有参数
    $c.find('#amily2_pf_type').on('change', function () {
        _switchParamSections($c, $(this).val());
    });

    // 弹窗：关闭
    $c.find('#amily2_profile_modal_close, #amily2_profile_modal_cancel').on('click', () => closeModal($c));
    $c.find('#amily2_profile_modal').on('click', function (e) {
        if (e.target === this) closeModal($c);
    });

    // 弹窗：保存
    $c.find('#amily2_profile_modal_save').on('click', () => saveProfile($c));

    // 初始渲染
    renderProfileList($c);
    renderSlotAssignments($c);
}

// ── 存储模式 ──────────────────────────────────────────────────────────────────

function _bindStorageMode($c) {
    const $select = $c.find('#amily2_keystore_mode');
    const $cloud  = $c.find('#amily2_cloud_key_section');
    const $note   = $c.find('#amily2_keystore_mode_note');

    const MODE_NOTES = {
        local: '本地存储：API Key 仅存于本设备浏览器，绝不上传服务端。换设备需重新填写。',
        cloud: '加密云同步：API Key 经 RSA+AES 混合加密后随设置同步。私钥仅留在本设备，服务商只能看到密文。',
    };

    // 初始状态
    const currentMode = apiKeyStore.getMode();
    $select.val(currentMode);
    $cloud.toggle(currentMode === 'cloud');
    $note.text(MODE_NOTES[currentMode]);
    if (currentMode === 'cloud') _refreshFingerprint($c);

    // 切换模式
    $select.on('change', async function () {
        const newMode = $(this).val();
        const confirmed = newMode === 'cloud'
            ? confirm('切换到加密云同步模式：\n将自动为本设备生成 RSA 密钥对，现有 Key 会重新加密存储。\n\n确认切换？')
            : confirm('切换回本地存储模式：\n已加密的 Key 将解密迁移至本地，云端密文会被清除。\n\n确认切换？');

        if (!confirmed) {
            $select.val(apiKeyStore.getMode());
            return;
        }

        try {
            await apiKeyStore.setMode(newMode);
            $cloud.toggle(newMode === 'cloud');
            $note.text(MODE_NOTES[newMode]);
            if (newMode === 'cloud') _refreshFingerprint($c);
            toastr.success(`已切换为${newMode === 'cloud' ? '加密云同步' : '本地存储'}模式。`);
        } catch (e) {
            console.error('[ApiConfig] 模式切换失败:', e);
            toastr.error('模式切换失败，请查看控制台。');
            $select.val(apiKeyStore.getMode());
        }
    });

    // 重新生成密钥对
    $c.find('#amily2_generate_keypair').on('click', async () => {
        if (!confirm('重新生成密钥对后，所有已加密的 API Key 将失效，需要逐一重新输入。\n\n确认重新生成？')) return;
        await apiKeyStore.generateKeyPair();
        _refreshFingerprint($c);
        toastr.warning('新密钥对已生成，请重新输入各 Profile 的 API Key。');
    });
}

async function _refreshFingerprint($c) {
    const fp = await apiKeyStore.getPublicKeyInfo();
    $c.find('#amily2_keypair_fingerprint').text(fp);
}

// ── Profile 列表渲染 ──────────────────────────────────────────────────────────

export function renderProfileList($c) {
    const $list = $c.find('#amily2_profile_list');
    const profiles = apiProfileManager.getProfiles(
        _currentFilter === 'all' ? undefined : _currentFilter
    );

    if (profiles.length === 0) {
        $list.html('<div class="amily2_profile_empty" style="color:var(--SmartThemeQuoteColor);text-align:center;padding:20px;">暂无连接配置，点击「新建配置」添加。</div>');
        return;
    }

    const TYPE_BADGE_COLOR = {
        chat:      'var(--SmartThemeBodyColor)',
        embedding: '#7eb8f7',
        rerank:    '#f7b07e',
    };

    const html = profiles.map(p => {
        const typeInfo = PROFILE_TYPES[p.type];
        const badgeStyle = `background:${TYPE_BADGE_COLOR[p.type]}22; color:${TYPE_BADGE_COLOR[p.type]}; border:1px solid ${TYPE_BADGE_COLOR[p.type]}55; border-radius:4px; padding:1px 6px; font-size:0.78em;`;
        return `
        <div class="amily2_profile_card" data-id="${p.id}" style="
            display:flex; align-items:center; gap:10px;
            padding:8px 12px;
            background:var(--black10a);
            border:1px solid var(--SmartThemeBorderColor);
            border-radius:6px;">
            <i class="fas ${typeInfo.icon}" style="width:16px; color:var(--SmartThemeQuoteColor);"></i>
            <div style="flex:1; min-width:0;">
                <div style="font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${_escapeHtml(p.name)}</div>
                <div style="font-size:0.82em; color:var(--SmartThemeQuoteColor); margin-top:2px;">
                    <span style="${badgeStyle}"><i class="fas ${typeInfo.icon}"></i> ${typeInfo.label}</span>
                    <span style="margin-left:6px;">${_escapeHtml(p.model || '（未设置模型）')}</span>
                    ${p.apiUrl ? `<span style="margin-left:6px; opacity:0.7;">${_escapeHtml(_truncateUrl(p.apiUrl))}</span>` : ''}
                </div>
            </div>
            <div style="display:flex; gap:4px; flex-shrink:0;">
                <button class="menu_button small_button interactable amily2_edit_profile" data-id="${p.id}" title="编辑">
                    <i class="fas fa-edit"></i>
                </button>
                <button class="menu_button small_button secondary interactable amily2_delete_profile" data-id="${p.id}" title="删除">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
        </div>`;
    }).join('');

    $list.html(html);

    // 编辑 / 删除事件
    $list.find('.amily2_edit_profile').on('click', function () {
        openModal($c, $(this).data('id'));
    });
    $list.find('.amily2_delete_profile').on('click', function () {
        const id   = $(this).data('id');
        const name = apiProfileManager.getProfile(id)?.name || id;
        if (!confirm(`确认删除连接配置「${name}」？\n此操作不可撤销，存储的 API Key 将同时清除。`)) return;
        apiProfileManager.deleteProfile(id);
        renderProfileList($c);
        renderSlotAssignments($c);
        toastr.success(`已删除配置「${name}」。`);
    });
}

// ── 功能槽分配渲染 ────────────────────────────────────────────────────────────

export function renderSlotAssignments($c) {
    const $slots = $c.find('#amily2_slot_assignments');

    const rows = Object.entries(SLOTS).map(([slot, slotInfo]) => {
        const profiles   = apiProfileManager.getProfiles(slotInfo.type);
        const assigned   = apiProfileManager.getAssignment(slot) || '';
        const typeInfo   = PROFILE_TYPES[slotInfo.type];

        const options = [
            `<option value="">— 未分配 —</option>`,
            ...profiles.map(p =>
                `<option value="${p.id}" ${p.id === assigned ? 'selected' : ''}>${_escapeHtml(p.name)}</option>`
            ),
        ].join('');

        return `
        <div style="display:flex; align-items:center; gap:8px; padding:4px 0;">
            <span style="width:160px; flex-shrink:0; font-size:0.9em;">${slotInfo.label}</span>
            <span style="color:var(--SmartThemeQuoteColor); font-size:0.78em; width:70px; flex-shrink:0;">
                <i class="fas ${typeInfo.icon}"></i> ${typeInfo.label}
            </span>
            <select class="text_pole amily2_slot_select" data-slot="${slot}" style="flex:1;">
                ${options}
            </select>
        </div>`;
    }).join('');

    $slots.html(rows);

    $slots.find('.amily2_slot_select').on('change', function () {
        const slot = $(this).data('slot');
        const id   = $(this).val() || null;
        if (!apiProfileManager.setAssignment(slot, id)) {
            toastr.error('类型不匹配，分配失败。');
            renderSlotAssignments($c);
        }
    });
}

// ── 弹窗操作 ──────────────────────────────────────────────────────────────────

async function openModal($c, id) {
    _editingId = id;
    const $modal = $c.find('#amily2_profile_modal');

    if (id) {
        // 编辑模式
        const p = apiProfileManager.getProfile(id);
        if (!p) return;
        $c.find('#amily2_profile_modal_title').html('<i class="fas fa-edit"></i> 编辑连接配置');
        $c.find('#amily2_pf_type').val(p.type).prop('disabled', true);   // 不允许修改类型
        $c.find('#amily2_pf_name').val(p.name);
        $c.find('#amily2_pf_provider').val(p.provider);
        $c.find('#amily2_pf_url').val(p.apiUrl);
        $c.find('#amily2_pf_key').val('');   // Key 不回显
        $c.find('#amily2_pf_model').val(p.model);

        if (p.type === 'chat') {
            $c.find('#amily2_pf_max_tokens').val(p.maxTokens);
            $c.find('#amily2_pf_temperature').val(p.temperature);
        } else if (p.type === 'embedding') {
            $c.find('#amily2_pf_dimensions').val(p.dimensions ?? '');
            $c.find('#amily2_pf_encoding_format').val(p.encodingFormat);
        } else if (p.type === 'rerank') {
            $c.find('#amily2_pf_top_n').val(p.topN);
            $c.find('#amily2_pf_return_documents').prop('checked', p.returnDocuments);
        }
        _switchParamSections($c, p.type);
    } else {
        // 新建模式
        $c.find('#amily2_profile_modal_title').html('<i class="fas fa-plus"></i> 新建连接配置');
        $c.find('#amily2_pf_type').val('chat').prop('disabled', false);
        $c.find('#amily2_pf_name, #amily2_pf_url, #amily2_pf_key, #amily2_pf_model').val('');
        $c.find('#amily2_pf_provider').val('openai');
        $c.find('#amily2_pf_max_tokens').val(65500);
        $c.find('#amily2_pf_temperature').val(1.0);
        $c.find('#amily2_pf_dimensions').val('');
        $c.find('#amily2_pf_encoding_format').val('float');
        $c.find('#amily2_pf_top_n').val(5);
        $c.find('#amily2_pf_return_documents').prop('checked', false);
        _switchParamSections($c, 'chat');
    }

    $modal.css('display', 'flex');
}

function closeModal($c) {
    $c.find('#amily2_profile_modal').hide();
    $c.find('#amily2_pf_type').prop('disabled', false);
    _editingId = null;
}

async function saveProfile($c) {
    const type     = $c.find('#amily2_pf_type').val();
    const name     = $c.find('#amily2_pf_name').val().trim();
    const provider = $c.find('#amily2_pf_provider').val();
    const apiUrl   = $c.find('#amily2_pf_url').val().trim();
    const apiKey   = $c.find('#amily2_pf_key').val();
    const model    = $c.find('#amily2_pf_model').val().trim();

    if (!name) { toastr.warning('请填写配置名称。'); return; }

    const data = { type, name, provider, apiUrl, model };

    if (type === 'chat') {
        data.maxTokens   = parseInt($c.find('#amily2_pf_max_tokens').val(), 10) || 65500;
        data.temperature = parseFloat($c.find('#amily2_pf_temperature').val()) || 1.0;
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
