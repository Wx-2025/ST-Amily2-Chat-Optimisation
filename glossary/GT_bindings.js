import { extension_settings, getContext } from "/scripts/extensions.js";
import { saveSettingsDebounced } from "/script.js";
import { extensionName } from "../utils/settings.js";
import { testSybdApiConnection, fetchSybdModels } from '../core/api/SybdApi.js';
import { handleFileUpload, recognizeChapters, processNovel } from './index.js';
import { SETTINGS_KEY as PRESET_SETTINGS_KEY } from '../PresetSettings/config.js';

function updateAndSaveSetting(key, value) {
    if (!extension_settings[extensionName]) {
        extension_settings[extensionName] = {};
    }
    extension_settings[extensionName][key] = value;
    saveSettingsDebounced();
    console.log(`[Amily2-术语表] 设置项 '${key}' 已更新为: ${JSON.stringify(value)}`);
}

function loadSettingsToUI() {
    const settings = extension_settings[extensionName] || {};
    const container = document.getElementById('amily2_glossary_panel');
    if (!container) return;

    const inputs = container.querySelectorAll('[data-setting-key]');
    inputs.forEach(target => {
        const key = target.dataset.settingKey;
        const value = settings[key];

        if (value === undefined) {
            let defaultValue;
            if (target.type === 'checkbox') {
                defaultValue = target.checked;
            } else if (target.type === 'range') {
                defaultValue = target.dataset.type === 'float' ? parseFloat(target.value) : parseInt(target.value, 10);
            } else {
                defaultValue = target.value;
            }
            updateAndSaveSetting(key, defaultValue);
            return;
        };

        if (target.type === 'checkbox') {
            target.checked = value;
        } else if (target.type === 'range') {
            target.value = value;
            const valueDisplay = document.getElementById(`${target.id}_value`);
            if (valueDisplay) valueDisplay.textContent = value;
        }
        else {
            target.value = value;
        }
    });

    const sybdToggle = document.getElementById('amily2_sybd_enabled');
    const sybdContent = document.getElementById('amily2_sybd_content');
    if (sybdToggle && sybdContent) {
        sybdContent.classList.toggle('amily2-content-hidden', !sybdToggle.checked);
    }

    const apiModeSelect = document.getElementById('amily2_sybd_api_mode');
    if (apiModeSelect) {
        updateConfigVisibility(apiModeSelect.value);
    }
}

function bindAutoSaveEvents() {
    const container = document.getElementById('amily2_glossary_panel');
    if (!container) return;

    const handler = (event) => {
        const target = event.target;
        const key = target.dataset.settingKey;
        if (!key) return;

        let value;
        const type = target.dataset.type || 'string';

        if (target.type === 'checkbox') {
            value = target.checked;
        } else {
            value = target.value;
        }

        switch (type) {
            case 'integer': value = parseInt(value, 10); break;
            case 'float': value = parseFloat(value); break;
            case 'boolean': value = (typeof value === 'boolean') ? value : (value === 'true'); break;
        }
        
        updateAndSaveSetting(key, value);

        if (key === 'sybdEnabled') {
            document.getElementById('amily2_sybd_content').classList.toggle('amily2-content-hidden', !value);
        }
        if (key === 'sybdApiMode') {
            updateConfigVisibility(value);
        }
        if (target.type === 'range') {
            document.getElementById(`${target.id}_value`).textContent = value;
        }
    };

    container.addEventListener('change', handler);
    container.addEventListener('input', (event) => {
        if (event.target.type === 'range') handler(event);
    });
}

function updateConfigVisibility(mode) {
    const compatibleConfig = document.getElementById('amily2_sybd_compatible_config');
    const presetConfig = document.getElementById('amily2_sybd_preset_config');

    if (mode === 'sillytavern_preset') {
        compatibleConfig.style.display = 'none';
        presetConfig.style.display = 'block';
        loadTavernPresets();
    } else {
        compatibleConfig.style.display = 'block';
        presetConfig.style.display = 'none';
    }
}

async function loadTavernPresets() {
    const select = document.getElementById('amily2_sybd_tavern_profile');
    if (!select) return;

    const currentValue = extension_settings[extensionName]?.sybdTavernProfile || '';
    select.innerHTML = '<option value="">-- 加载中 --</option>';

    try {
        const context = getContext();
        const tavernProfiles = context.extensionSettings?.connectionManager?.profiles || [];
        
        select.innerHTML = '<option value="">-- 请选择预设 --</option>';
        
        if (tavernProfiles.length > 0) {
            tavernProfiles.forEach(profile => {
                if (profile.api && profile.preset) {
                    const option = new Option(profile.name || profile.id, profile.id);
                    select.add(option);
                }
            });
            select.value = currentValue;
        } else {
            select.innerHTML = '<option value="">未找到可用预设</option>';
        }
    } catch (error) {
        console.error('[Amily2-术语表] 加载SillyTavern预设失败:', error);
        select.innerHTML = '<option value="">加载失败</option>';
    }
}

function bindManualActionEvents() {
    const testBtn = document.getElementById('amily2_sybd_test_connection');
    if (testBtn) {
        testBtn.addEventListener('click', async () => {
            const originalHtml = testBtn.innerHTML;
            testBtn.disabled = true;
            testBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 测试中';
            await testSybdApiConnection();
            testBtn.disabled = false;
            testBtn.innerHTML = originalHtml;
        });
    }

    const fetchBtn = document.getElementById('amily2_sybd_fetch_models');
    const modelSelect = document.getElementById('amily2_sybd_model_select');
    const modelInput = document.getElementById('amily2_sybd_model');

    if (fetchBtn && modelSelect && modelInput) {
        fetchBtn.addEventListener('click', async () => {
            const originalHtml = fetchBtn.innerHTML;
            fetchBtn.disabled = true;
            fetchBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 获取中';
            
            try {
                const models = await fetchSybdModels();
                if (models && models.length > 0) {
                    modelSelect.innerHTML = '<option value="">-- 请选择模型 --</option>';
                    models.forEach(model => {
                        const option = new Option(model.name || model.id, model.id);
                        modelSelect.add(option);
                    });
                    
                    modelSelect.style.display = 'block';
                    modelInput.style.display = 'none';
                    toastr.success(`成功获取 ${models.length} 个模型`);
                } else {
                    toastr.warning('未获取到任何模型');
                }
            } catch (error) {
                toastr.error(`获取模型失败: ${error.message}`);
            } finally {
                fetchBtn.disabled = false;
                fetchBtn.innerHTML = originalHtml;
            }
        });

        modelSelect.addEventListener('change', () => {
            const selectedModel = modelSelect.value;
            if (selectedModel) {
                modelInput.value = selectedModel;
                modelInput.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });
    }
}

function bindTabEvents() {
    const tabs = document.querySelectorAll('.glossary-tab');
    const contents = document.querySelectorAll('.glossary-content');

    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const tabId = tab.dataset.tab;

            tabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            contents.forEach(content => {
                if (content.id === `glossary-content-${tabId}`) {
                    content.classList.add('active');
                } else {
                    content.classList.remove('active');
                }
            });

        });
    });
}

function bindNovelProcessEvents() {
    const fileInput = document.getElementById('novel-file-input');
    const fileLabel = document.querySelector('label[for="novel-file-input"]');
    const recognizeBtn = document.getElementById('novel-recognize-chapters');
    const processBtn = document.getElementById('novel-confirm-and-process');

    if (fileLabel && fileInput) {
        fileLabel.addEventListener('click', (event) => {
            event.preventDefault(); 
            fileInput.click(); 
        });
        fileInput.addEventListener('change', (event) => {
            handleFileUpload(event.target.files[0]);
        });
    }

    if (recognizeBtn) {
        recognizeBtn.addEventListener('click', async () => {
            const originalHtml = recognizeBtn.innerHTML;
            recognizeBtn.disabled = true;
            recognizeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 识别中...';
            
            await recognizeChapters();

            recognizeBtn.disabled = false;
            recognizeBtn.innerHTML = originalHtml;
        });
    }

    if (processBtn) {
        processBtn.addEventListener('click', async () => {
            const originalHtml = processBtn.innerHTML;
            processBtn.disabled = true;
            processBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 处理中...';

            await processNovel();

            processBtn.disabled = false;
            processBtn.innerHTML = originalHtml;
        });
    }
}

export function bindGlossaryEvents() {
    const panel = document.getElementById('amily2_glossary_panel');
    if (!panel || panel.dataset.eventsBound) {
        return;
    }

    console.log('[Amily2-术语表] 开始绑定UI事件 (最终重构版)...');

    loadSettingsToUI();
    bindAutoSaveEvents();
    bindManualActionEvents();
    bindTabEvents();
    bindNovelProcessEvents();

    panel.dataset.eventsBound = 'true';
    console.log('[Amily2-术语表] UI事件绑定完成 (最终重构版)。');
}
