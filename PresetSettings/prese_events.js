import * as state from './prese_state.js';
import * as ui from './prese_ui.js';
import { bindDragEvents } from './prese_dragdrop.js';
import { sectionTitles } from './config.js';

function updatePresetsFromUI(context) {
    const currentPresets = state.getCurrentPresets();
    context.find('.prompt-section').each(function() {
        const sectionKey = $(this).data('section');
        if (sectionKey && currentPresets[sectionKey]) {
            $(this).find('.mixed-list .mixed-item[data-type="prompt"]').each(function() {
                const promptIndex = $(this).data('prompt-index');
                const role = $(this).find('.role-select').val();
                const content = $(this).find('.content-textarea').val();
                
                if (currentPresets[sectionKey][promptIndex]) {
                    currentPresets[sectionKey][promptIndex] = { role, content };
                }
            });
        }
    });
    state.setCurrentPresets(currentPresets);
}

function exportSectionPreset(sectionKey) {
    const sectionConfig = {
        presets: { [sectionKey]: state.getCurrentPresets()[sectionKey] },
        mixedOrder: { [sectionKey]: state.getCurrentMixedOrder()[sectionKey] },
        version: 'v2.1_section',
        sectionName: sectionTitles[sectionKey],
        exportTime: new Date().toISOString()
    };
    
    const blob = new Blob([JSON.stringify(sectionConfig, null, 2)], {
        type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `amily2_${sectionKey}_preset.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    toastr.success(`${sectionTitles[sectionKey]} 已导出！`);
}

function importSectionPreset(sectionKey, context) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const imported = JSON.parse(e.target.result);
                    const currentPresets = state.getCurrentPresets();
                    const currentMixedOrder = state.getCurrentMixedOrder();

                    if (imported.version === 'v2.1_section' && imported.presets && imported.mixedOrder) {
                        if (imported.presets[sectionKey] && imported.mixedOrder[sectionKey]) {
                            currentPresets[sectionKey] = imported.presets[sectionKey];
                            currentMixedOrder[sectionKey] = imported.mixedOrder[sectionKey];
                            toastr.success(`${sectionTitles[sectionKey]} 已成功导入！`);
                        } else {
                            throw new Error("文件中不包含对应的section数据");
                        }
                    } else if (imported.version === 'v2.1' && imported.presets && imported.mixedOrder) {
                        if (imported.presets[sectionKey] && imported.mixedOrder[sectionKey]) {
                            currentPresets[sectionKey] = imported.presets[sectionKey];
                            currentMixedOrder[sectionKey] = imported.mixedOrder[sectionKey];
                            toastr.success(`${sectionTitles[sectionKey]} 已成功导入！`);
                        } else {
                            throw new Error("文件中不包含对应的section数据");
                        }
                    } else if (imported[sectionKey]) {
                        currentPresets[sectionKey] = imported[sectionKey];
                        toastr.success(`${sectionTitles[sectionKey]} 已成功导入（使用默认条件块顺序）！`);
                    } else {
                        throw new Error("无法识别的文件格式或不包含对应section数据");
                    }
                    
                    state.setCurrentPresets(currentPresets);
                    state.setCurrentMixedOrder(currentMixedOrder);
                    state.savePresets();
                    if (context && context.length) {
                        ui.renderEditor(context);
                    }
                } catch (error) {
                    console.error("Import section error:", error);
                    toastr.error(`导入失败：${error.message}`);
                }
            };
            reader.readAsText(file);
        }
    };
    input.click();
}

export function bindEvents(context) {
    context.find('.add-prompt-item').off('click.amily2').on('click.amily2', function() {
        const sectionKey = $(this).closest('.prompt-section').data('section');
        const currentPresets = state.getCurrentPresets();
        const currentMixedOrder = state.getCurrentMixedOrder();
        
        currentPresets[sectionKey].push({ role: 'system', content: '' });
        currentMixedOrder[sectionKey].push({ type: 'prompt', index: currentPresets[sectionKey].length - 1 });
        
        state.setCurrentPresets(currentPresets);
        state.setCurrentMixedOrder(currentMixedOrder);
        
        ui.renderEditor(context);
        toastr.info('新提示词已添加，点击保存按钮完成操作');
    });

    context.find('.delete-mixed-item').off('click.amily2').on('click.amily2', function() {
        const item = $(this).closest('.mixed-item');
        const sectionKey = item.data('section');
        const orderIndex = item.data('order-index');
        const itemType = item.data('type');
        
        const currentPresets = state.getCurrentPresets();
        const currentMixedOrder = state.getCurrentMixedOrder();

        if (itemType === 'prompt') {
            const promptIndex = item.data('prompt-index');
            currentPresets[sectionKey].splice(promptIndex, 1);
            currentMixedOrder[sectionKey].forEach(orderItem => {
                if (orderItem.type === 'prompt' && orderItem.index > promptIndex) {
                    orderItem.index--;
                }
            });
        }
        
        currentMixedOrder[sectionKey].splice(orderIndex, 1);
        
        state.setCurrentPresets(currentPresets);
        state.setCurrentMixedOrder(currentMixedOrder);
        
        ui.renderEditor(context);
        toastr.info('项目已删除，点击保存按钮完成操作');
    });

    context.off('change.amily2', '.role-select').on('change.amily2', '.role-select', function() {
        updatePresetsFromUI(context);
    });
    
    context.off('input.amily2 paste.amily2 keyup.amily2', '.content-textarea').on('input.amily2 paste.amily2 keyup.amily2', function() {
        updatePresetsFromUI(context);
    });

    context.find('#preset-select').off('change.amily2').on('change.amily2', function() {
        const selectedPreset = $(this).val();
        if (state.switchPreset(selectedPreset)) {
            ui.renderEditor(context);
        }
    });

    context.find('#new-preset').off('click.amily2').on('click.amily2', () => {
        if (state.createNewPreset()) {
            ui.renderPresetManager(context);
            ui.renderEditor(context);
        }
    });

    context.find('#rename-preset').off('click.amily2').on('click.amily2', () => {
        if (state.renamePreset()) {
            ui.renderPresetManager(context);
            ui.renderEditor(context);
        }
    });

    context.find('#delete-preset').off('click.amily2').on('click.amily2', () => {
        if (state.deletePreset()) {
            ui.renderPresetManager(context);
            ui.renderEditor(context);
        }
    });

    context.find('.save-section-preset').off('click.amily2').on('click.amily2', function() {
        const sectionKey = $(this).closest('.prompt-section').data('section');
        updatePresetsFromUI(context);
        state.savePresets();
        toastr.success(`${sectionTitles[sectionKey]} in preset "${state.getPresetManager().activePreset}" has been saved!`);
    });

    context.find('.import-section-preset').off('click.amily2').on('click.amily2', function() {
        const sectionKey = $(this).closest('.prompt-section').data('section');
        importSectionPreset(sectionKey, context);
    });

    context.find('.export-section-preset').off('click.amily2').on('click.amily2', function() {
        const sectionKey = $(this).closest('.prompt-section').data('section');
        exportSectionPreset(sectionKey);
    });

    context.find('.reset-section-preset').off('click.amily2').on('click.amily2', function() {
        const sectionKey = $(this).closest('.prompt-section').data('section');
        if (confirm(`您确定要将 ${sectionTitles[sectionKey]} 恢复为默认设置吗？`)) {
            state.resetSectionPreset(sectionKey);
            ui.renderEditor(context);
        }
    });

    context.find('.collapsible-header').off('click.amily2').on('click.amily2', function() {
        const sectionKey = $(this).closest('.prompt-section').data('section');
        const content = $(this).next('.collapsible-content');
        const icon = $(this).find('.collapse-icon');
        const globalCollapseState = ui.getGlobalCollapseState();
        
        content.slideToggle(200, function() {
            const isVisible = content.is(':visible');
            icon.text(isVisible ? '▼' : '▶');
            globalCollapseState[sectionKey] = isVisible;
        });
    });

    bindDragEvents(context);
}
