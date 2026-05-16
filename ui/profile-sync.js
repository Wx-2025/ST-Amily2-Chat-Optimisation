/**
 * ui/profile-sync.js - Synchronize central API profiles into legacy sub-panels.
 *
 * The central API profile assignment is authoritative. Sub-panels only show a
 * profile selector card and keep legacy URL/key/model fields hidden. When a
 * profile is assigned we still backfill those hidden fields so older fallback
 * code that reads from DOM continues to work during the migration.
 */

import { apiProfileManager, PROFILE_TYPES, SLOTS } from '../utils/config/ApiProfileManager.js';
import { getRequestHeaders } from '/script.js';
import { testApiConnection } from '../core/api.js';
import { testJqyhApiConnection } from '../core/api/JqyhApi.js';
import { testConcurrentApiConnection } from '../core/api/ConcurrentApi.js';
import { testNgmsApiConnection } from '../core/api/Ngms_api.js';
import { testNccsApiConnection } from '../core/api/NccsApi.js';
import { testSybdApiConnection } from '../core/api/SybdApi.js';
import { testCwbConnection } from '../CharacterWorldBook/src/cwb_apiService.js';
import { testConnection as testAutoCharCardConnection } from '../core/auto-char-card/api.js';
import {
    executeRerank as executeRagRerank,
    fetchEmbeddingModels as fetchRagEmbeddingModels,
    fetchRerankModels as fetchRagRerankModels,
    testApiConnection as testRagEmbeddingConnection,
} from '../core/rag-api.js';

const BLOCK_SEL = '.amily2_settings_block, .control-group, .amily2_opt_settings_block, .acc-form-group, .hly-control-block';
const CARD_CLASS = 'amily2_profile_status_card';
const CARD_SLOT_ATTR = 'data-card-slot';
const HIDDEN_ATTR = 'data-profile-hidden';
const MASKED_KEY = '••••••••';

const _fieldSnapshots = {};

const SLOT_CONFIGS = {
    main: {
        container: 'closest-fieldset:#amily2_api_provider',
        hideParentBlock: ['#amily2_api_provider', '#amily2_model_selector'],
        hideDirectly: ['#amily2_api_url_wrapper', '#amily2_api_key_wrapper', '#amily2_preset_wrapper'],
        fields: { provider: '#amily2_api_provider', apiUrl: '#amily2_api_url', model: '#amily2_manual_model_input' },
        keyField: '#amily2_api_key',
        testFn: testApiConnection,
    },
    plotOpt: {
        container: '#amily2_jqyh_content',
        hideParentBlock: ['#amily2_jqyh_api_mode'],
        hideDirectly: ['#amily2_jqyh_compatible_config', '#amily2_jqyh_preset_config'],
        hideInContainer: ['.jqyh-button-row'],
        fields: { provider: '#amily2_jqyh_api_mode', apiUrl: '#amily2_jqyh_api_url', model: '#amily2_jqyh_model' },
        keyField: '#amily2_jqyh_api_key',
        testFn: testJqyhApiConnection,
    },
    plotOptConc: {
        container: '#amily2_concurrent_content',
        hideWithLabel: [
            '#amily2_plotOpt_concurrentApiProvider',
            '#amily2_plotOpt_concurrentApiUrl',
            '#amily2_plotOpt_concurrentApiKey',
            '#amily2_plotOpt_concurrentModel',
        ],
        hideInContainer: ['.jqyh-button-row'],
        fields: {
            provider: '#amily2_plotOpt_concurrentApiProvider',
            apiUrl: '#amily2_plotOpt_concurrentApiUrl',
            model: '#amily2_plotOpt_concurrentModel',
        },
        keyField: '#amily2_plotOpt_concurrentApiKey',
        testFn: testConcurrentApiConnection,
    },
    nccs: {
        container: '#nccs-api-config',
        hideParentBlock: [
            '#nccs-api-mode',
            '#nccs-api-url',
            '#nccs-api-key',
            '#nccs-api-model',
            '#nccs-api-fakestream-enabled',
            '#nccs-sillytavern-preset',
        ],
        hideInContainer: ['.nccs-button-row'],
        fields: { provider: '#nccs-api-mode', apiUrl: '#nccs-api-url', model: '#nccs-api-model' },
        keyField: '#nccs-api-key',
        testFn: testNccsApiConnection,
    },
    ngms: {
        container: '#amily2_ngms_content',
        hideParentBlock: ['#amily2_ngms_api_mode', '#amily2_ngms_fakestream_enabled'],
        hideDirectly: ['#amily2_ngms_compatible_config', '#amily2_ngms_preset_config'],
        hideInContainer: ['.ngms-button-row'],
        fields: { provider: '#amily2_ngms_api_mode', apiUrl: '#amily2_ngms_api_url', model: '#amily2_ngms_model' },
        keyField: '#amily2_ngms_api_key',
        testFn: testNgmsApiConnection,
    },
    sybd: {
        container: '#amily2_sybd_content',
        hideParentBlock: ['#amily2_sybd_api_mode'],
        hideDirectly: ['#amily2_sybd_compatible_config', '#amily2_sybd_preset_config'],
        hideInContainer: ['.sybd-button-row'],
        fields: { provider: '#amily2_sybd_api_mode', apiUrl: '#amily2_sybd_api_url', model: '#amily2_sybd_model' },
        keyField: '#amily2_sybd_api_key',
        testFn: testSybdApiConnection,
    },
    cwb: {
        container: '#cwb-api-settings-tab',
        hideDirectly: [
            'label[for="cwb-api-mode"]',
            '#cwb-api-mode',
            'label[for="cwb-api-url"]',
            '#cwb-api-url',
            'label[for="cwb-api-key"]',
            '#cwb-api-key',
            'label[for="cwb-api-model"]',
            '#cwb-api-model',
            'label[for="cwb-tavern-profile"]',
            '#cwb-tavern-profile',
        ],
        hideInContainer: ['.jqyh-button-row'],
        fields: { provider: '#cwb-api-mode', apiUrl: '#cwb-api-url', model: '#cwb-api-model' },
        keyField: '#cwb-api-key',
        testFn: testCwbConnection,
    },
    autoCharCard: {
        container: '#acc-api-settings-content',
        hideParentBlock: ['#acc-executor-url', '#acc-executor-key', '#acc-executor-model'],
        hideDirectly: ['#acc-executor-refresh-models', '#acc-executor-test', '#acc-save-api'],
        fields: { apiUrl: '#acc-executor-url', model: '#acc-executor-model' },
        keyField: '#acc-executor-key',
        testFn: async () => testAutoCharCardConnection('executor'),
    },
    ragEmbed: {
        container: '#hly-retrieval-tab .hly-settings-group',
        hideParentBlock: ['#hly-api-endpoint', '#hly-custom-api-url', '#hly-api-key', '#hly-embedding-model'],
        hideDirectly: [
            'button[onclick="testHLYApi()"]',
            'button[onclick="fetchHLYEmbeddingModels()"]',
        ],
        fields: { provider: '#hly-api-endpoint', apiUrl: '#hly-custom-api-url', model: '#hly-embedding-model' },
        keyField: '#hly-api-key',
        testFn: async () => {
            await testRagEmbeddingConnection();
            return true;
        },
        fetchModelsFn: fetchRagEmbeddingModels,
    },
    ragRerank: {
        container: '#hly-rerank-tab .hly-settings-group',
        hideParentBlock: ['#hly-rerank-api-mode', '#hly-rerank-url', '#hly-rerank-api-key', '#hly-rerank-model'],
        fields: { provider: '#hly-rerank-api-mode', apiUrl: '#hly-rerank-url', model: '#hly-rerank-model' },
        keyField: '#hly-rerank-api-key',
        testFn: async () => {
            await executeRagRerank('test', ['test'], null);
            return true;
        },
        fetchModelsFn: fetchRagRerankModels,
    },
};

export async function syncSlot(slot) {
    const config = SLOT_CONFIGS[slot];
    if (!config) return;

    const container = _resolveContainer(config.container);
    if (!container) return;

    _removeCard(slot);
    _restoreHidden(slot);
    _snapshotLegacyFields(slot, config);

    const profile = await apiProfileManager.getAssignedProfile(slot);
    if (profile) _fillLegacyFields(config, profile);

    _hideApiFields(config, container, slot);
    _injectCard(slot, profile, config, container);
}

export async function syncAllSlots() {
    await Promise.all(Object.keys(SLOT_CONFIGS).map(syncSlot));
}

document.addEventListener('amily2:slotAssigned', (e) => {
    const slot = e.detail?.slot;
    if (slot) syncSlot(slot);
});

function _resolveContainer(spec) {
    if (!spec) return null;
    if (spec.startsWith('closest-fieldset:')) {
        const anchorSel = spec.slice('closest-fieldset:'.length);
        const anchor = document.querySelector(anchorSel);
        return anchor?.closest('fieldset') ?? null;
    }
    return document.querySelector(spec);
}

function _snapshotLegacyFields(slot, config) {
    if (_fieldSnapshots[slot]) return;

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
}

function _fillLegacyFields(config, profile) {
    for (const [key, sel] of Object.entries(config.fields || {})) {
        const el = document.querySelector(sel);
        if (el) el.value = profile[key] ?? '';
    }
    if (config.keyField) {
        const keyEl = document.querySelector(config.keyField);
        if (keyEl) keyEl.value = profile.apiKey ? MASKED_KEY : '';
    }
}

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
    (config.hideParentBlock || []).forEach(sel => {
        const el = document.querySelector(sel);
        if (!el) return;
        const block = el.closest(BLOCK_SEL);
        if (block && block !== container) _hideEl(block, slot);
    });

    (config.hideDirectly || []).forEach(sel => {
        const el = document.querySelector(sel);
        if (el) _hideEl(el, slot);
    });

    (config.hideWithLabel || []).forEach(sel => {
        const el = document.querySelector(sel);
        if (!el) return;

        let target = el;
        while (target.parentElement && target.parentElement !== container) {
            target = target.parentElement;
        }

        _hideEl(target, slot);
        const prev = target.previousElementSibling;
        if (prev && prev.tagName === 'LABEL') _hideEl(prev, slot);
    });

    (config.hideInContainer || []).forEach(sel => {
        container.querySelectorAll(sel).forEach(el => _hideEl(el, slot));
    });
}

function _removeCard(slot) {
    document.querySelectorAll(`.${CARD_CLASS}[${CARD_SLOT_ATTR}="${slot}"]`)
        .forEach(el => el.remove());
}

function _injectCard(slot, profile, _config, container) {
    const slotInfo = SLOTS[slot] || { label: slot, type: 'chat' };
    const typeInfo = PROFILE_TYPES[slotInfo.type] || {};
    const assigned = apiProfileManager.getAssignment(slot) || '';
    const profiles = apiProfileManager.getProfiles(slotInfo.type);
    const providerLabel = _providerLabel(profile?.provider);

    const options = [
        `<option value="">-- 未分配，请选择 API 连接 --</option>`,
        ...profiles.map(p =>
            `<option value="${_esc(p.id)}" ${p.id === assigned ? 'selected' : ''}>${_esc(p.name)}</option>`
        ),
    ].join('');

    const detailHtml = profile ? `
        <span style="color:var(--SmartThemeQuoteColor); font-size:0.85em;">
            ${providerLabel ? `<i class="fas fa-cloud"></i> ${_esc(providerLabel)}` : ''}
            ${profile.model ? ` · <i class="fas fa-robot"></i> ${_esc(profile.model)}` : ''}
        </span>
    ` : `
        <span style="color:var(--warning-color); font-size:0.85em;">
            未分配时该模块不会继续展示/保存独立 API 输入项。
        </span>
    `;

    const card = document.createElement('div');
    card.className = CARD_CLASS;
    card.setAttribute(CARD_SLOT_ATTR, slot);
    card.style.cssText = [
        'padding:10px 14px',
        'margin:6px 0 10px',
        'background:var(--black10a)',
        'border:1px solid var(--SmartThemeBorderColor)',
        'border-radius:6px',
        'font-size:0.88em',
    ].join(';');

    card.innerHTML = `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px; flex-wrap:wrap;">
            <i class="fas ${_esc(typeInfo.icon || 'fa-link')}" style="color:var(--green,#4caf50);"></i>
            <span style="font-weight:600;">${_esc(slotInfo.label)}</span>
            ${detailHtml}
            <span class="amily2_psc_goto" style="margin-left:auto; opacity:0.7; font-size:0.85em; cursor:pointer;"
                  title="前往统一 API 配置页">
                <i class="fas fa-cog"></i> 管理
            </span>
        </div>
        <select class="text_pole amily2_psc_select" data-slot="${_esc(slot)}" style="width:100%; margin-bottom:8px;">
            ${options}
        </select>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
            <button class="menu_button small_button interactable amily2_psc_test" type="button" ${profile ? '' : 'disabled'}>
                <i class="fas fa-plug"></i> 测试连接
            </button>
            <button class="menu_button small_button interactable amily2_psc_fetch" type="button" ${profile ? '' : 'disabled'}>
                <i class="fas fa-list"></i> 获取模型
            </button>
            <span class="amily2_psc_result" style="font-size:0.85em; display:flex; align-items:center; margin-left:4px;"></span>
        </div>`;

    card.querySelector('.amily2_psc_goto').addEventListener('click', () => {
        document.getElementById('amily2_open_api_config')?.click();
    });

    card.querySelector('.amily2_psc_select').addEventListener('change', function () {
        const id = this.value || null;
        if (!apiProfileManager.setAssignment(slot, id)) {
            toastr.error('配置类型不匹配，分配失败。');
            syncSlot(slot);
            return;
        }
        document.dispatchEvent(new CustomEvent('amily2:slotAssigned', { detail: { slot } }));
    });

    card.querySelector('.amily2_psc_test').addEventListener('click', () => _testSlot(slot, card));
    card.querySelector('.amily2_psc_fetch').addEventListener('click', () => _fetchSlotModels(slot, card));

    const legend = container.querySelector(':scope > legend');
    if (legend) {
        legend.insertAdjacentElement('afterend', card);
    } else {
        container.prepend(card);
    }
}

async function _testSlot(slot, card) {
    const $btn = $(card.querySelector('.amily2_psc_test')).prop('disabled', true);
    const $result = $(card.querySelector('.amily2_psc_result'));
    $btn.html('<i class="fas fa-spinner fa-spin"></i> 测试中...');
    $result.text('').css('color', '');

    try {
        const profile = await apiProfileManager.getAssignedProfile(slot);
        if (!profile) {
            $result.text('槽位未分配').css('color', 'var(--warning-color)');
            return;
        }

        const testFn = SLOT_CONFIGS[slot]?.testFn;
        if (!testFn) {
            $result.text('该槽位暂不支持快捷测试').css('color', 'var(--warning-color)');
            return;
        }

        const result = await testFn();
        const success = typeof result === 'object' ? result?.success : result;

        if (success === true) {
            $result.text('测试通过').css('color', 'var(--green)');
        } else if (success === false) {
            $result.text(result?.error || '测试失败，请查看弹窗/控制台').css('color', 'var(--warning-color)');
        }
    } catch (e) {
        $result.text(`错误：${e.message}`).css('color', 'var(--warning-color)');
    } finally {
        $btn.prop('disabled', false).html('<i class="fas fa-plug"></i> 测试连接');
    }
}

async function _fetchSlotModels(slot, card) {
    const $btn = $(card.querySelector('.amily2_psc_fetch')).prop('disabled', true);
    const $result = $(card.querySelector('.amily2_psc_result'));
    $btn.html('<i class="fas fa-spinner fa-spin"></i> 获取中...');
    $result.text('').css('color', '');

    try {
        const profile = await apiProfileManager.getAssignedProfile(slot);
        if (!profile) {
            $result.text('槽位未分配').css('color', 'var(--warning-color)');
            return;
        }

        if (profile.provider === 'sillytavern_preset' || profile.provider === 'sillytavern_backend') {
            $result.text('ST 预设/后端管理，无需获取').css('color', 'var(--SmartThemeQuoteColor)');
            return;
        }

        const customFetch = SLOT_CONFIGS[slot]?.fetchModelsFn;
        const models = customFetch ? await customFetch() : await _loadModels(profile);
        if (models.length === 0) {
            $result.text('未获取到模型').css('color', 'var(--warning-color)');
            return;
        }

        const current = profile.model;
        const inList = current && models.includes(current);
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

async function _loadModels(profile) {
    if (profile.provider === 'google') {
        if (!profile.apiKey) throw new Error('API Key 为空');
        const resp = await fetch(
            'https://generativelanguage.googleapis.com/v1beta/models',
            { headers: { 'x-goog-api-key': profile.apiKey } }
        );
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        return (data.models ?? [])
            .filter(m => m.supportedGenerationMethods?.some(method => ['generateContent', 'embedContent'].includes(method)))
            .map(m => m.name.replace(/^models\//, ''))
            .sort((a, b) => a.localeCompare(b));
    }

    const resp = await fetch('/api/backends/chat-completions/status', {
        method: 'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({
            reverse_proxy: profile.apiUrl,
            proxy_password: profile.apiKey,
            chat_completion_source: 'openai',
        }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const rawData = await resp.json();
    const list = Array.isArray(rawData) ? rawData : (rawData.data ?? rawData.models ?? []);
    return list
        .map(m => m.id ?? m.name ?? m)
        .filter(m => typeof m === 'string' && m)
        .sort((a, b) => a.localeCompare(b));
}

function _providerLabel(provider) {
    return {
        openai: 'OpenAI 兼容',
        openai_test: '全兼容',
        google: 'Google Gemini',
        sillytavern_backend: 'ST 后端',
        sillytavern_preset: 'ST 预设',
    }[provider] || provider || '';
}

function _esc(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
