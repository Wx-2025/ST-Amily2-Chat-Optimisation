import { extensionName } from "../../utils/settings.js";
import { extension_settings } from "/scripts/extensions.js";
import { saveSettingsDebounced } from "/script.js";
import { initializeSuperMemory } from "./manager.js";

export function bindSuperMemoryEvents() {
    const panel = $('#amily2_super_memory_panel');
    if (panel.length === 0) return;

    panel.on('click', '.sm-nav-item', function() {
        const tab = $(this).data('tab');
        
        panel.find('.sm-nav-item').removeClass('active');
        $(this).addClass('active');

        panel.find('.sm-tab-pane').removeClass('active');
        panel.find(`#sm-${tab}-tab`).addClass('active');
    });

    panel.on('change', 'input[type="checkbox"]', function() {
        if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
        
        const id = this.id;
        let key = null;
        
        if (id === 'sm-system-enabled') key = 'super_memory_enabled'; 
        if (id === 'sm-bridge-enabled') key = 'superMemory_bridgeEnabled';

        if (key) {
            extension_settings[extensionName][key] = this.checked;
            saveSettingsDebounced();
            console.log(`[Amily2-SuperMemory] Setting updated: ${key} = ${this.checked}`);
        }
    });

    panel.on('change', 'input[type="number"], input[type="text"]', function() {
        if (!extension_settings[extensionName]) extension_settings[extensionName] = {};
        
        const id = this.id;
        let key = null;

        if (id === 'sm-index-depth') key = 'superMemory_indexDepth';
        if (id === 'sm-detail-depth') key = 'superMemory_detailDepth';

        if (key) {
            let value = this.value;
            if (this.type === 'number') value = parseInt(value, 10);
            
            extension_settings[extensionName][key] = value;
            saveSettingsDebounced();
            console.log(`[Amily2-SuperMemory] Setting updated: ${key} = ${value}`);
        }
    });

    loadSuperMemorySettings();
    
    console.log('[Amily2-SuperMemory] Events bound successfully.');
}

function loadSuperMemorySettings() {
    const settings = extension_settings[extensionName] || {};
    
    $('#sm-system-enabled').prop('checked', settings.super_memory_enabled ?? false); 
    $('#sm-bridge-enabled').prop('checked', settings.superMemory_bridgeEnabled ?? false); 

    $('#sm-index-depth').val(settings.superMemory_indexDepth ?? 0);
    $('#sm-detail-depth').val(settings.superMemory_detailDepth ?? 2);
}

window.sm_initializeSystem = async function() {
    toastr.info('超级记忆系统正在初始化...');
    $('#sm-system-status').text('初始化中...').css('color', 'yellow');
    
    try {
        await initializeSuperMemory();
        toastr.success('超级记忆系统初始化完成。');
    } catch (error) {
        console.error(error);
        toastr.error('初始化失败，请检查控制台。');
        $('#sm-system-status').text('错误').css('color', 'red');
    }
};

window.sm_purgeMemory = function() {
    if (confirm('您确定要清空所有超级记忆数据吗？')) {
        toastr.warning('记忆已清空。');
        $('#sm-system-status').text('未初始化').css('color', '#ffc107');
    }
};
