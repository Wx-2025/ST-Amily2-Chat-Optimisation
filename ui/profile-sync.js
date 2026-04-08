/**
 * ui/profile-sync.js — API Profile → 子面板 UI 同步
 *
 * 当某功能槽分配了 Profile 时：
 *   1. 隐藏对应功能区的 API 连接配置字段（保留温度/Token 等生成参数）
 *   2. 注入一张状态卡，显示 Profile 信息 + 测试连接 / 获取模型按钮
 *
 * 当槽位未分配时：恢复旧字段显示，移除状态卡。
 *
 * 用法：
 *   import { syncAllSlots, syncSlot } from './profile-sync.js';
 *   await syncAllSlots();      // 面板初始化时全量同步
 *   await syncSlot('main');    // 单个槽位分配变更时调用
 *
 * 外部事件：
 *   document 上监听 'amily2:slotAssigned'，detail = { slot }
 *   由 api-config-bindings.js 在分配变更后 dispatch。
 */

import { apiProfileManager } from '../utils/config/ApiProfileManager.js';
import { getRequestHeaders } from '/script.js';
import { testApiConnection } from '../core/api.js';
import { testConcurrentApiConnection } from '../core/api/ConcurrentApi.js';
import { testNgmsApiConnection } from '../core/api/Ngms_api.js';
import { testNccsApiConnection } from '../core/api/NccsApi.js';

// ── 常量 ──────────────────────────────────────────────────────────────────────

// 用于通过子元素定位父 block 的选择器
const BLOCK_SEL = '.amily2_settings_block, .control-group, .amily2_opt_settings_block';

// 每个槽位在回填 Profile 值前的 DOM 字段快照（用于取消分配时还原）
// 结构：{ [slot]: { [selector]: value } }
const _fieldSnapshots = {};

const CARD_CLASS     = 'amily2_profile_status_card';
const CARD_SLOT_ATTR = 'data-card-slot';
const HIDDEN_ATTR    = 'data-profile-hidden';

// ── 槽位 → DOM 映射 ───────────────────────────────────────────────────────────
//
// container      : 状态卡注入的父容器（CSS 选择器或 'closest-fieldset:xxx'）
// hideParentBlock: 通过子元素选择器找到其最近的 BLOCK_SEL 父元素并隐藏
// hideDirectly   : 直接隐藏的元素选择器
// hideWithLabel  : 隐藏元素（上溯到容器直接子元素）+ 前一个兄弟 <label>（inline-grid 布局用）
// hideInContainer: 在容器内 querySelector 查找并隐藏
// fields         : { profileKey: domSelector } — 用于回填值（向下兼容 fallback 读取）
// keyField       : API Key 输入框（回填遮蔽值）
// testFn         : 测试连接函数（发送真实聊天请求）

const SLOT_CONFIGS = {
    main: {
        container:      'closest-fieldset:#amily2_api_provider',
        hideParentBlock: ['#amily2_api_provider', '#amily2_model_selector'],
        hideDirectly:    ['#amily2_api_url_wrapper', '#amily2_api_key_wrapper', '#amily2_preset_wrapper'],
        hideWithLabel:   [],
        hideInContainer: [],
        fields:   { provider: '#amily2_api_provider', apiUrl: '#amily2_api_url', model: '#amily2_manual_model_input' },
        keyField: '#amily2_api_key',
        testFn:   testApiConnection,
    },
    plotOpt: {
        container:      '#amily2_opt_custom_api_settings_block',
        hideParentBlock: [],
        hideDirectly:    [],
        hideWithLabel:   [],
        hideInContainer: [],
        fields:   { apiUrl: '#amily2_opt_api_url', model: '#amily2_opt_model' },
        keyField: '#amily2_opt_api_key',
        testFn:   null,
    },
    plotOptConc: {
        container:      '#amily2_concurrent_content',
        hideParentBlock: [],
        hideDirectly:    [],
        hideWithLabel:   [
            '#amily2_plotOpt_concurrentApiProvider',
            '#amily2_plotOpt_concurrentApiUrl',
            '#amily2_plotOpt_concurrentApiKey',
            '#amily2_plotOpt_concurrentModel',
        ],
        hideInContainer: ['.jqyh-button-row'],
        fields:   { provider: '#amily2_plotOpt_concurrentApiProvider', apiUrl: '#amily2_plotOpt_concurrentApiUrl', model: '#amily2_plotOpt_concurrentModel' },
        keyField: '#amily2_plotOpt_concurrentApiKey',
        testFn:   testConcurrentApiConnection,
    },
    nccs: {
        container:      '#nccs-api-config',
        hideParentBlock: ['#nccs-api-mode', '#nccs-api-url', '#nccs-api-key', '#nccs-api-model', '#nccs-api-fakestream-enabled', '#nccs-sillytavern-preset'],
        hideDirectly:    [],
        hideWithLabel:   [],
        hideInContainer: ['.nccs-button-row'],
        fields:   { apiUrl: '#nccs-api-url', model: '#nccs-api-model' },
        keyField: '#nccs-api-key',
        testFn:   testNccsApiConnection,
    },
    ngms: {
        container:      '#amily2_ngms_content',
        hideParentBlock: ['#amily2_ngms_api_mode', '#amily2_ngms_fakestream_enabled'],
        hideDirectly:    ['#amily2_ngms_compatible_config', '#amily2_ngms_preset_config'],
        hideWithLabel:   [],
        hideInContainer: ['.ngms-button-row'],
        fields:   { apiUrl: '#amily2_ngms_api_url', model: '#amily2_ngms_model' },
        keyField: '#amily2_ngms_api_key',
        testFn:   testNgmsApiConnection,
    },
};

// ── 公开 API ──────────────────────────────────────────────────────────────────

/** 同步单个槽位到对应 DOM 区域。 */
export async function syncSlot(slot) {
    const config = SLOT_CONFIGS[slot];
    if (!config) return;

    const profile = await apiProfileManager.getAssignedProfile(slot);

    // 先清理：移除旧卡片、恢复被隐藏的元素
    _removeCard(slot);
    _restoreHidden(slot);

    if (!profile) {
        // 取消分配：将 DOM 字段值还原为分配 Profile 前的快照，
        // 防止残留的 Profile 回填值（尤其是 '••••••••' 的 Key 占位符）
        // 因 blur 事件被误存入 extension_settings / localStorage。
        const snap = _fieldSnapshots[slot];
        if (snap) {
            for (const [sel, val] of Object.entries(snap)) {
                const el = document.querySelector(sel);
                if (el) el.value = val;
            }
            delete _fieldSnapshots[slot];
        }
        return;
    }

    const container = _resolveContainer(config.container);
    if (!container) return;

    // 回填前先快照各字段当前值（即 extension_settings / configManager 中的真实值），
    // 以便取消分配时能还原，避免 Profile 值污染旧配置。
    const snap = {};
    for (const sel of Object.values(config.fields || {})) {
        const el = document.querySelector(sel);
        if (el) snap[sel] = el.value;
    }
    if (config.keyField) {
        const keyEl = document.querySelector(config.keyField);
        if (keyEl) snap[config.keyField] = keyEl.value;
    }
    _fieldSnapshots[slot] = snap;

    // 回填值（向下兼容：部分代码仍从 DOM 读取 fallback）
    for (const [key, sel] of Object.entries(config.fields || {})) {
        const el = document.querySelector(sel);
        if (el) el.value = profile[key] ?? '';
    }
    if (config.keyField) {
        const keyEl = document.querySelector(config.keyField);
        if (keyEl) keyEl.value = profile.apiKey ? '••••••••' : '';
    }

    // 隐藏 API 连接字段（保留温度 / 最大 Token 等生成参数）
    _hideApiFields(config, container, slot);

    // 注入状态卡
    _injectCard(slot, profile, config, container);
}

/** 同步所有槽位（面板初始化时调用）。 */
export async function syncAllSlots() {
    await Promise.all(Object.keys(SLOT_CONFIGS).map(syncSlot));
}

// ── 事件监听：响应 api-config-bindings 的 slotAssigned 事件 ──────────────────

document.addEventListener('amily2:slotAssigned', (e) => {
    const slot = e.detail?.slot;
    if (slot) syncSlot(slot);
});

// ── 内部：容器定位 ──────────────────────────────────────────────────────────────

function _resolveContainer(spec) {
    if (!spec) return null;

    // 'closest-fieldset:#amily2_api_provider' → 从该元素向上找 fieldset
    if (spec.startsWith('closest-fieldset:')) {
        const anchorSel = spec.slice('closest-fieldset:'.length);
        const anchor = document.querySelector(anchorSel);
        return anchor?.closest('fieldset') ?? null;
    }

    return document.querySelector(spec);
}

// ── 内部：隐藏 / 恢复 API 字段 ──────────────────────────────────────────────────

function _hideEl(el, slot) {
    if (!el || el.hasAttribute(HIDDEN_ATTR)) return;
    el.setAttribute(HIDDEN_ATTR, slot);
    el.setAttribute('data-prev-display', el.style.display || '');
    el.style.display = 'none';
}

function _restoreHidden(slot) {
    document.querySelectorAll(`[${HIDDEN_ATTR}="${slot}"]`).forEach(el => {
        el.style.display = el.getAttribute('data-prev-display') || '';
        el.removeAttribute(HIDDEN_ATTR);
        el.removeAttribute('data-prev-display');
    });
}

function _hideApiFields(config, container, slot) {
    // 1. 通过子元素找到其父 block 并隐藏
    (config.hideParentBlock || []).forEach(sel => {
        const el = document.querySelector(sel);
        if (!el) return;
        const block = el.closest(BLOCK_SEL);
        if (block && block !== container) _hideEl(block, slot);
    });

    // 2. 直接隐藏指定元素
    (config.hideDirectly || []).forEach(sel => {
        const el = document.querySelector(sel);
        if (el) _hideEl(el, slot);
    });

    // 3. 隐藏元素（上溯到容器直接子元素）+ 前一个兄弟 label（inline-grid 布局）
    (config.hideWithLabel || []).forEach(sel => {
        const el = document.querySelector(sel);
        if (!el) return;
        // 沿 DOM 树上溯到容器的直接子元素
        let target = el;
        while (target.parentElement && target.parentElement !== container) {
            target = target.parentElement;
        }
        _hideEl(target, slot);
        const prev = target.previousElementSibling;
        if (prev && prev.tagName === 'LABEL') _hideEl(prev, slot);
    });

    // 4. 在容器内查找并隐藏
    (config.hideInContainer || []).forEach(sel => {
        const el = container.querySelector(sel);
        if (el) _hideEl(el, slot);
    });
}

// ── 内部：状态卡 ──────────────────────────────────────────────────────────────

function _removeCard(slot) {
    document.querySelectorAll(`.${CARD_CLASS}[${CARD_SLOT_ATTR}="${slot}"]`)
        .forEach(el => el.remove());
}

function _injectCard(slot, profile, _config, container) {
    const card = document.createElement('div');
    card.className = CARD_CLASS;
    card.setAttribute(CARD_SLOT_ATTR, slot);
    card.style.cssText = [
        'padding:10px 14px', 'margin:6px 0 10px',
        'background:var(--black10a)',
        'border:1px solid var(--SmartThemeBorderColor)',
        'border-radius:6px', 'font-size:0.88em',
    ].join(';');

    const providerLabel = {
        openai:              'OpenAI 兼容',
        openai_test:         '全兼容',
        google:              'Google Gemini',
        sillytavern_backend: 'ST 后端',
        sillytavern_preset:  'ST 预设',
    }[profile.provider] || profile.provider || '';

    card.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
            <i class="fas fa-link" style="color:var(--green,#4caf50);"></i>
            <span style="font-weight:600;">${_esc(profile.name)}</span>
            <span style="color:var(--SmartThemeQuoteColor); font-size:0.85em;">
                ${providerLabel ? `<i class="fas fa-cloud"></i> ${_esc(providerLabel)}` : ''}
                ${profile.model ? ` · <i class="fas fa-robot"></i> ${_esc(profile.model)}` : ''}
            </span>
            <span class="amily2_psc_goto" style="margin-left:auto; opacity:0.6; font-size:0.85em; cursor:pointer;"
                  title="前往 API 配置页面">
                <i class="fas fa-cog"></i> 管理
            </span>
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button class="menu_button small_button interactable amily2_psc_test" type="button">
                <i class="fas fa-plug"></i> 测试连接
            </button>
            <button class="menu_button small_button interactable amily2_psc_fetch" type="button">
                <i class="fas fa-list"></i> 获取模型
            </button>
            <span class="amily2_psc_result" style="font-size:0.85em; display:flex; align-items:center; margin-left:4px;"></span>
        </div>`;

    // 绑定按钮事件
    card.querySelector('.amily2_psc_goto').addEventListener('click', () => {
        document.getElementById('amily2_open_api_config')?.click();
    });
    card.querySelector('.amily2_psc_test').addEventListener('click', () => _testSlot(slot, card));
    card.querySelector('.amily2_psc_fetch').addEventListener('click', () => _fetchSlotModels(slot, card));

    // 插入到 legend 之后（fieldset）或容器开头
    const legend = container.querySelector(':scope > legend');
    if (legend) {
        legend.insertAdjacentElement('afterend', card);
    } else {
        container.prepend(card);
    }
}

// ── 内部：测试连接（调用各模块的真实测试函数，发送聊天请求）──────────────────────

async function _testSlot(slot, card) {
    const $btn    = $(card.querySelector('.amily2_psc_test')).prop('disabled', true);
    const $result = $(card.querySelector('.amily2_psc_result'));
    $btn.html('<i class="fas fa-spinner fa-spin"></i> 测试中...');
    $result.text('').css('color', '');

    try {
        const testFn = SLOT_CONFIGS[slot]?.testFn;
        if (!testFn) {
            $result.text('该槽位不支持测试').css('color', 'var(--warning-color)');
            return;
        }

        // 调用模块原生测试函数（发送 "你好！" 聊天请求验证连接）
        const success = await testFn();

        if (success === true) {
            $result.text('测试通过').css('color', 'var(--green)');
        } else if (success === false) {
            $result.text('测试失败（详见弹窗）').css('color', 'var(--warning-color)');
        }
        // undefined = 函数未执行（如 DOM 依赖缺失），不更新卡片
    } catch (e) {
        $result.text(`错误：${e.message}`).css('color', 'var(--warning-color)');
    } finally {
        $btn.prop('disabled', false).html('<i class="fas fa-plug"></i> 测试连接');
    }
}

// ── 内部：获取模型列表 ──────────────────────────────────────────────────────────

async function _fetchSlotModels(slot, card) {
    const $btn    = $(card.querySelector('.amily2_psc_fetch')).prop('disabled', true);
    const $result = $(card.querySelector('.amily2_psc_result'));
    $btn.html('<i class="fas fa-spinner fa-spin"></i> 获取中...');
    $result.text('').css('color', '');

    try {
        const profile = await apiProfileManager.getAssignedProfile(slot);
        if (!profile) {
            $result.text('槽位未分配').css('color', 'var(--warning-color)');
            return;
        }

        // ST 预设由酒馆管理，无法获取模型列表
        if (profile.provider === 'sillytavern_preset' || profile.provider === 'sillytavern_backend') {
            $result.text('ST 预设/后端管理，无需获取').css('color', 'var(--SmartThemeQuoteColor)');
            return;
        }

        let models = [];

        if (profile.provider === 'google') {
            if (!profile.apiKey) {
                $result.text('API Key 为空').css('color', 'var(--warning-color)');
                return;
            }
            const resp = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(profile.apiKey)}`
            );
            if (!resp.ok) {
                $result.text(`失败：HTTP ${resp.status}`).css('color', 'var(--warning-color)');
                return;
            }
            const data = await resp.json();
            models = (data.models ?? [])
                .filter(m => m.supportedGenerationMethods?.some(
                    method => ['generateContent', 'embedContent'].includes(method)
                ))
                .map(m => m.name.replace(/^models\//, ''));
        } else {
            // OpenAI 兼容 — 通过 ST 后端代理获取模型列表
            const resp = await fetch('/api/backends/chat-completions/status', {
                method: 'POST',
                headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    reverse_proxy: profile.apiUrl,
                    proxy_password: profile.apiKey,
                    chat_completion_source: 'openai',
                }),
            });
            if (!resp.ok) {
                $result.text(`失败：HTTP ${resp.status}`).css('color', 'var(--warning-color)');
                return;
            }
            const rawData = await resp.json();
            const list = Array.isArray(rawData) ? rawData : (rawData.data ?? rawData.models ?? []);
            models = list.map(m => m.id ?? m.name ?? m).filter(m => typeof m === 'string' && m);
        }

        if (models.length === 0) {
            $result.text('未获取到模型').css('color', 'var(--warning-color)');
            return;
        }

        const current = profile.model;
        const inList  = current && models.includes(current);
        $result.html(
            `<span style="color:var(--green);">${models.length} 个模型</span>` +
            (current ? ` · 当前: <b>${_esc(current)}</b> ${inList ? '✓' : '<span style="color:var(--warning-color);">（不在列表中）</span>'}` : '')
        );
        toastr.success(`已获取 ${models.length} 个模型。`, `槽位：${slot}`);
    } catch (e) {
        $result.text(`错误：${e.message}`).css('color', 'var(--warning-color)');
    } finally {
        $btn.prop('disabled', false).html('<i class="fas fa-list"></i> 获取模型');
    }
}

// ── 工具 ──────────────────────────────────────────────────────────────────────

function _esc(str) {
    return String(str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
