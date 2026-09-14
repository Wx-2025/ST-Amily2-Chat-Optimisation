import { renderExtensionTemplateAsync } from "/scripts/extensions.js";
import { POPUP_TYPE, Popup } from "/scripts/popup.js";
import { makeDraggable } from './draggable.js';
import { sectionTitles, conditionalBlocks, presetSettingsPath } from './config.js';
import * as state from './prese_state.js';
import { bindEvents } from './prese_events.js';
import { presetText, presetHtml, presetAttr, presetEscape, presetBlockHtml, presetToast, bindPresetTranslations, releasePresetTranslations, setPresetText } from './i18n.js';

let settingsOrb = null;
let globalCollapseState = {};

export function renderPresetManager(context) {
    const presetManager = state.getPresetManager();
    const managerHtml = `
        <div id="preset-manager" style="padding: 8px; border-bottom: 1px solid #ccc; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <label for="preset-select" style="margin-bottom: 0; font-size: 12px;">${presetHtml('preset.select')}</label>
            <select id="preset-select" class="form-control" style="display: inline-block; width: auto; font-size: 12px; padding: 4px 8px; min-width: 120px;"></select>
            <button id="new-preset" class="btn btn-primary btn-sm" style="font-size: 11px; padding: 4px 8px;">${presetHtml('preset.new')}</button>
            <button id="rename-preset" class="btn btn-secondary btn-sm" style="font-size: 11px; padding: 4px 8px;">${presetHtml('preset.rename')}</button>
            <button id="delete-preset" class="btn btn-danger btn-sm" style="font-size: 11px; padding: 4px 8px;">${presetHtml('preset.delete')}</button>
        </div>
    `;
    releasePresetTranslations(context.find('#preset-manager-container'));
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
    bindPresetTranslations(context);
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

    releasePresetTranslations(container);
    container.empty();

    for (const sectionKey in sectionTitles) {
        const prompts = currentPresets[sectionKey] || [];
        const order = currentMixedOrder[sectionKey] || [];

        const sectionHtml = $(`
            <div class="prompt-section" data-section="${presetEscape(sectionKey)}">
                <h3 class="collapsible-header" style="cursor: pointer; user-select: none;">${presetHtml(`section.${sectionKey}`)} <span class="collapse-icon">▶</span></h3>
                <div class="collapsible-content" style="display: none;">
                    <p class="text-muted">${presetHtml('section.hint')}</p>
                    <div class="mixed-list"></div>
                    <div class="section-controls">
                        <button class="add-prompt-item btn btn-primary">${presetHtml('section.add')}</button>
                        <div class="section-action-buttons" style="margin-top: 10px;">
                            <button class="save-section-preset btn btn-success btn-sm">${presetHtml('section.save')}</button>
                            <button class="import-section-preset btn btn-info btn-sm">${presetHtml('section.import')}</button>
                            <button class="export-section-preset btn btn-warning btn-sm">${presetHtml('section.export')}</button>
                            <button class="reset-section-preset btn btn-danger btn-sm">${presetHtml('section.reset')}</button>
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

    bindPresetTranslations(context);
    bindEvents(context);
}

function createMixedPromptItemHtml(prompt, promptIndex, orderIndex, sectionKey) {
    return `
        <div class="mixed-item prompt-item" data-type="prompt" data-prompt-index="${presetEscape(promptIndex)}" data-order-index="${presetEscape(orderIndex)}" data-section="${presetEscape(sectionKey)}" draggable="false">
            <div class="item-header">
                <span class="drag-handle" draggable="true" ${presetAttr('prompt.drag')}>⋮⋮</span>
                <div class="role-selector-group">
                    <select class="role-select form-control" ${presetAttr('role.label', 'aria-label')} style="width: 100px; max-width: 100%; font-size: 11px; padding: 2px 4px; margin-right: 4px;">
                        <option value="system" data-preset-editor-i18n="role.system" ${prompt.role === 'system' ? 'selected' : ''}>${presetEscape(presetText('role.system'))}</option>
                        <option value="user" data-preset-editor-i18n="role.user" ${prompt.role === 'user' ? 'selected' : ''}>${presetEscape(presetText('role.user'))}</option>
                        <option value="assistant" data-preset-editor-i18n="role.assistant" ${prompt.role === 'assistant' ? 'selected' : ''}>${presetEscape(presetText('role.assistant'))}</option>
                    </select>
                </div>
                <div class="item-controls">
                    <button class="delete-mixed-item btn btn-sm btn-danger" ${presetAttr('prompt.delete')} ${presetAttr('prompt.delete', 'aria-label')}>X</button>
                </div>
            </div>
            <div class="item-content">
                <textarea class="content-textarea form-control" ${presetAttr('prompt.content', 'aria-label')}>
${presetEscape(prompt.content)}</textarea>
            </div>
        </div>
    `;
}

function createMixedConditionalItemHtml(block, orderIndex, sectionKey) {
    return `
        <div class="mixed-item conditional-item" data-type="conditional" data-conditional-id="${presetEscape(block.id)}" data-order-index="${presetEscape(orderIndex)}" data-section="${presetEscape(sectionKey)}" draggable="false">
            <div class="conditional-line-format">
                <span class="drag-handle" draggable="true" ${presetAttr('prompt.drag')}>⋮⋮</span>
                <span class="conditional-prefix">${presetHtml('block.label')}</span>
                <span class="conditional-dashes">---</span>
                <span class="conditional-name">${presetBlockHtml(block, sectionKey, 'name')}</span>
                <span class="conditional-dashes">---</span>
            </div>
            <div class="conditional-description">
                <code class="text-muted small">${presetBlockHtml(block, sectionKey, 'description')}</code>
            </div>
        </div>
    `;
}

export function toggleSettingsOrb() {
    if (settingsOrb && settingsOrb.length > 0) {
        releasePresetTranslations(settingsOrb);
        settingsOrb.remove();
        settingsOrb = null;
        presetToast('info', 'orb.closed');
    } else {
        settingsOrb = $(`<div id="amily2-settings-orb" ${presetAttr('orb.title')}></div>`);
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
        bindPresetTranslations(settingsOrb);

        makeDraggable(settingsOrb, showPresetSettings, 'amily2_settingsOrb_pos');
        presetToast('info', 'orb.opened');
    }
}

export async function showPresetSettings() {
    const template = $(await renderExtensionTemplateAsync(presetSettingsPath, 'prese-settings'));

    renderPresetManager(template);
    renderEditor(template);

    const popup = new Popup(template, POPUP_TYPE.TEXT, presetEscape(presetText('title')), {
        wide: true,
        large: true,
        okButton: presetEscape(presetText('close')),
        cancelButton: false,
        onOpen: popup => {
            popup.okButton?.removeAttribute('data-i18n');
            setPresetText(popup.okButton, 'close');
            bindPresetTranslations(template);
        },
    });

    try {
        await popup.show();
    } finally {
        releasePresetTranslations(popup.dlg);
        releasePresetTranslations(template);
    }
}

export function addPresetSettingsButton() {
    const button = document.createElement('div');
    button.id = 'amily2-preset-settings-button';
    button.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    button.innerHTML = `<i class="fa-solid fa-scroll"></i>${presetHtml('menu')}`;
    button.addEventListener('click', toggleSettingsOrb);

    const extensionsMenu = document.getElementById('extensionsMenu');
    if (extensionsMenu && !document.getElementById(button.id)) {
        extensionsMenu.appendChild(button);
        bindPresetTranslations(button);
    }
}

export function getGlobalCollapseState() {
    return globalCollapseState;
}
