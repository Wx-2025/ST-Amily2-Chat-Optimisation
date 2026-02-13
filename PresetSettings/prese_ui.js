import { renderExtensionTemplateAsync } from "/scripts/extensions.js";
import { POPUP_TYPE, Popup } from "/scripts/popup.js";
import { makeDraggable } from './draggable.js';
import { sectionTitles, conditionalBlocks, presetSettingsPath } from './config.js';
import * as state from './prese_state.js';
import { bindEvents } from './prese_events.js';

let settingsOrb = null;
let globalCollapseState = {};

export function renderPresetManager(context) {
    const presetManager = state.getPresetManager();
    const managerHtml = `
        <div id="preset-manager" style="padding: 8px; border-bottom: 1px solid #ccc; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <label for="preset-select" style="margin-bottom: 0; font-size: 12px; white-space: nowrap;">选择预设:</label>
            <select id="preset-select" class="form-control" style="display: inline-block; width: auto; font-size: 12px; padding: 4px 8px; min-width: 120px;"></select>
            <button id="new-preset" class="btn btn-primary btn-sm" style="font-size: 11px; padding: 4px 8px;">新建</button>
            <button id="rename-preset" class="btn btn-secondary btn-sm" style="font-size: 11px; padding: 4px 8px;">重命名</button>
            <button id="delete-preset" class="btn btn-danger btn-sm" style="font-size: 11px; padding: 4px 8px;">删除</button>
        </div>
    `;
    context.find('#preset-manager-container').html(managerHtml);

    const select = context.find('#preset-select');
    select.empty();
    for (const presetName in presetManager.presets) {
        const option = $('<option></option>').val(presetName).text(presetName);
        if (presetName === presetManager.activePreset) {
            option.prop('selected', true);
        }
        select.append(option);
    }
}

export function renderEditor(context) {
    const container = context.find('#prompt-editor-container');
    const currentPresets = state.getCurrentPresets();
    const currentMixedOrder = state.getCurrentMixedOrder();

    if (!container.length) {
        console.error("Amily2 [renderEditor]: Could not find #prompt-editor-container.");
        return;
    }

    const openSections = new Set();
    container.find('.prompt-section').each(function() {
        const sectionKey = $(this).data('section');
        const content = $(this).find('.collapsible-content');
        if (content.is(':visible')) {
            openSections.add(sectionKey);
        }
    });

    container.empty();

    for (const sectionKey in sectionTitles) {
        const sectionTitle = sectionTitles[sectionKey];
        const prompts = currentPresets[sectionKey] || [];
        const order = currentMixedOrder[sectionKey] || [];

        const sectionHtml = $(`
            <div class="prompt-section" data-section="${sectionKey}">
                <h3 class="collapsible-header" style="cursor: pointer; user-select: none;">${sectionTitle} <span class="collapse-icon">▶</span></h3>
                <div class="collapsible-content" style="display: none;">
                    <p class="text-muted">拖拽排序：普通提示词和条件块可自由调整顺序</p>
                    <div class="mixed-list"></div>
                    <div class="section-controls">
                        <button class="add-prompt-item btn btn-primary">+ 提示词</button>
                        <div class="section-action-buttons" style="margin-top: 10px;">
                            <button class="save-section-preset btn btn-success btn-sm">保存</button>
                            <button class="import-section-preset btn btn-info btn-sm">导入</button>
                            <button class="export-section-preset btn btn-warning btn-sm">导出</button>
                            <button class="reset-section-preset btn btn-danger btn-sm">恢复默认</button>
                        </div>
                    </div>
                </div>
            </div>
        `);

        const listContainer = sectionHtml.find('.mixed-list');

        order.forEach((item, orderIndex) => {
            let itemHtml;
            if (item.type === 'prompt') {
                const prompt = prompts[item.index];
                if (prompt) {
                    itemHtml = createMixedPromptItemHtml(prompt, item.index, orderIndex, sectionKey);
                }
            } else if (item.type === 'conditional') {
                const block = conditionalBlocks[sectionKey]?.find(b => b.id === item.id);
                if (block) {
                    itemHtml = createMixedConditionalItemHtml(block, orderIndex, sectionKey);
                }
            }

            if (itemHtml) {
                listContainer.append(itemHtml);
            }
        });

        container.append(sectionHtml);
    }

    setTimeout(() => {
        container.find('.prompt-section').each(function() {
            const sectionKey = $(this).data('section');
            const contentElement = $(this).find('.collapsible-content');
            const iconElement = $(this).find('.collapse-icon');
            
            const isExpanded = globalCollapseState[sectionKey] === true || openSections.has(sectionKey);
            
            if (isExpanded) {
                contentElement.show();
                iconElement.text('▼');
            } else {
                contentElement.hide();
                iconElement.text('▶');
            }
        });
    }, 0);

    bindEvents(context);
}

function createMixedPromptItemHtml(prompt, promptIndex, orderIndex, sectionKey) {
    return `
        <div class="mixed-item prompt-item" data-type="prompt" data-prompt-index="${promptIndex}" data-order-index="${orderIndex}" data-section="${sectionKey}" draggable="false">
            <div class="item-header">
                <span class="drag-handle" draggable="true">⋮⋮</span>
                <div class="role-selector-group">
                    <select class="role-select form-control" style="width: 80px; font-size: 11px; padding: 2px 4px; margin-right: 4px;">
                        <option value="system" ${prompt.role === 'system' ? 'selected' : ''}>系统</option>
                        <option value="user" ${prompt.role === 'user' ? 'selected' : ''}>用户</option>
                        <option value="assistant" ${prompt.role === 'assistant' ? 'selected' : ''}>AI</option>
                    </select>
                </div>
                <div class="item-controls">
                    <button class="delete-mixed-item btn btn-sm btn-danger">X</button>
                </div>
            </div>
            <div class="item-content">
                <textarea class="content-textarea form-control">${prompt.content}</textarea>
            </div>
        </div>
    `;
}

function createMixedConditionalItemHtml(block, orderIndex, sectionKey) {
    return `
        <div class="mixed-item conditional-item" data-type="conditional" data-conditional-id="${block.id}" data-order-index="${orderIndex}" data-section="${sectionKey}" draggable="false">
            <div class="conditional-line-format">
                <span class="drag-handle" draggable="true">⋮⋮</span>
                <span class="conditional-prefix">条件块</span>
                <span class="conditional-dashes">---</span>
                <span class="conditional-name">${block.name}</span>
                <span class="conditional-dashes">---</span>
            </div>
            <div class="conditional-description">
                <code class="text-muted small">${block.description}</code>
            </div>
        </div>
    `;
}

export function toggleSettingsOrb() {
    if (settingsOrb && settingsOrb.length > 0) {
        settingsOrb.remove();
        settingsOrb = null;
        toastr.info('提示词链编辑器已关闭。');
    } else {
        settingsOrb = $(`<div id="amily2-settings-orb" title="点击打开提示词链编辑器 (可拖拽)"></div>`);
        settingsOrb.css({
            position: 'fixed',
            top: '85%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: '50px',
            height: '50px',
            backgroundColor: 'var(--primary-color)',
            color: 'white',
            borderRadius: '50%',
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            cursor: 'grab',
            zIndex: '9998',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
        });
        settingsOrb.html('<i class="fa-solid fa-scroll fa-lg"></i>');
        $('body').append(settingsOrb);

        makeDraggable(settingsOrb, showPresetSettings, 'amily2_settingsOrb_pos');
        toastr.info('提示词链编辑器已开启。');
    }
}

async function showPresetSettings() {
    const template = $(await renderExtensionTemplateAsync(presetSettingsPath, 'prese-settings'));

    renderPresetManager(template);
    renderEditor(template);

    const popup = new Popup(template, POPUP_TYPE.TEXT, 'Amily2 提示词链编辑器', {
        wide: true,
        large: true,
        okButton: '关闭',
        cancelButton: false,
    });

    await popup.show();
}

export function addPresetSettingsButton() {
    const button = document.createElement('div');
    button.id = 'amily2-preset-settings-button';
    button.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    button.innerHTML = `<i class="fa-solid fa-scroll"></i><span>Amily2 提示词链</span>`;
    button.addEventListener('click', toggleSettingsOrb);

    const extensionsMenu = document.getElementById('extensionsMenu');
    if (extensionsMenu && !document.getElementById(button.id)) {
        extensionsMenu.appendChild(button);
    }
}

export function getGlobalCollapseState() {
    return globalCollapseState;
}
