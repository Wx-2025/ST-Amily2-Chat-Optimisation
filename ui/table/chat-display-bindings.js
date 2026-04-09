export function bindChatTableDisplaySetting({
    getLiveExtensionSettings,
    saveSettingsDebounced,
    log,
}) {
    const settings = getLiveExtensionSettings();
    const showInChatToggle = document.getElementById('show-table-in-chat-toggle');
    const continuousRenderToggle = document.getElementById('render-on-every-message-toggle');

    if (!showInChatToggle || !continuousRenderToggle) {
        log('Chat table display toggles not found, skip binding.', 'warn');
        return;
    }

    showInChatToggle.checked = settings.show_table_in_chat === true;
    continuousRenderToggle.checked = settings.render_on_every_message === true;

    const updateContinuousRenderState = () => {
        const controlBlock = continuousRenderToggle.closest('.control-block-with-switch');
        if (showInChatToggle.checked) {
            continuousRenderToggle.disabled = false;
            if (controlBlock) controlBlock.style.opacity = '1';
            return;
        }

        continuousRenderToggle.disabled = true;
        if (controlBlock) controlBlock.style.opacity = '0.5';
    };

    updateContinuousRenderState();

    showInChatToggle.addEventListener('change', () => {
        const currentSettings = getLiveExtensionSettings();
        currentSettings.show_table_in_chat = showInChatToggle.checked;
        saveSettingsDebounced();
        toastr.info(`Chat table display ${showInChatToggle.checked ? 'enabled' : 'disabled'}.`);
        updateContinuousRenderState();
    });

    continuousRenderToggle.addEventListener('change', () => {
        const currentSettings = getLiveExtensionSettings();
        currentSettings.render_on_every_message = continuousRenderToggle.checked;
        saveSettingsDebounced();
        toastr.info(`Continuous chat render ${continuousRenderToggle.checked ? 'enabled' : 'disabled'}.`);
    });

    log('Chat table display settings bound.', 'success');
}
