export function bindNccsApiEvents({
    getLiveExtensionSettings,
    saveSettingsDebounced,
    getContext,
    fetchNccsModels,
    testNccsApiConnection,
    configManager,
    log,
}) {
    const settings = getLiveExtensionSettings();

    if (settings.nccsEnabled === undefined) settings.nccsEnabled = false;
    if (settings.nccsFakeStreamEnabled === undefined) settings.nccsFakeStreamEnabled = false;
    if (settings.nccsApiMode === undefined) settings.nccsApiMode = 'openai_test';
    if (settings.nccsApiUrl === undefined) settings.nccsApiUrl = 'https://api.openai.com/v1';
    if (settings.nccsModel === undefined) settings.nccsModel = '';
    if (settings.nccsTavernProfile === undefined) settings.nccsTavernProfile = '';

    const enabledToggle = document.getElementById('nccs-api-enabled');
    const enabledFakeStreamToggle = document.getElementById('nccs-api-fakestream-enabled');
    const configDiv = document.getElementById('nccs-api-config');
    const modeSelect = document.getElementById('nccs-api-mode');
    const urlInput = document.getElementById('nccs-api-url');
    const keyInput = document.getElementById('nccs-api-key');
    const modelInput = document.getElementById('nccs-api-model');
    const presetSelect = document.getElementById('nccs-sillytavern-preset');
    const testButton = document.getElementById('nccs-test-connection');
    const fetchModelsButton = document.getElementById('nccs-fetch-models');

    if (!enabledToggle || !enabledFakeStreamToggle || !configDiv) {
        return;
    }

    enabledToggle.checked = settings.nccsEnabled;
    enabledFakeStreamToggle.checked = settings.nccsFakeStreamEnabled;
    if (modeSelect) modeSelect.value = settings.nccsApiMode;
    if (urlInput) urlInput.value = settings.nccsApiUrl;
    if (keyInput) keyInput.value = configManager.get('nccsApiKey') || '';
    if (modelInput) modelInput.value = settings.nccsModel;
    if (presetSelect) presetSelect.value = settings.nccsTavernProfile || '';

    const updateConfigVisibility = () => {
        configDiv.style.display = enabledToggle.checked ? 'block' : 'none';
    };

    const updateModeBasedVisibility = () => {
        if (!modeSelect) return;

        const isPresetMode = modeSelect.value === 'sillytavern_preset';
        const presetContainer = presetSelect?.closest('.amily2_opt_settings_block');
        if (presetContainer) {
            presetContainer.style.display = isPresetMode ? 'block' : 'none';
        }

        [urlInput, keyInput, modelInput].forEach((element) => {
            const container = element?.closest('.amily2_opt_settings_block');
            if (container) {
                container.style.display = isPresetMode ? 'none' : 'block';
            }
        });

        const buttonsContainer = testButton?.closest('.nccs-button-row');
        if (buttonsContainer) {
            buttonsContainer.style.display = 'flex';
        }
    };

    const saveSetting = (key, value) => {
        const currentSettings = getLiveExtensionSettings();
        currentSettings[key] = value;
        saveSettingsDebounced();
    };

    const loadSillyTavernPresets = async () => {
        if (!presetSelect) return;

        try {
            const context = getContext();
            const profiles = context?.extensionSettings?.connectionManager?.profiles;
            if (!profiles) {
                throw new Error('Unable to load SillyTavern presets.');
            }

            const currentProfileId = getLiveExtensionSettings().nccsTavernProfile;
            presetSelect.innerHTML = '';
            presetSelect.appendChild(new Option('Select preset', '', false, false));

            if (profiles.length === 0) {
                log('No SillyTavern presets found.', 'warn');
                return;
            }

            profiles.forEach((profile) => {
                const isSelected = profile.id === currentProfileId;
                presetSelect.appendChild(new Option(profile.name, profile.id, isSelected, isSelected));
            });

            log(`Loaded ${profiles.length} SillyTavern presets.`, 'success');
        } catch (error) {
            log(`Failed to load SillyTavern presets: ${error.message}`, 'error');
        }
    };

    updateConfigVisibility();
    updateModeBasedVisibility();

    enabledToggle.addEventListener('change', () => {
        saveSetting('nccsEnabled', enabledToggle.checked);
        updateConfigVisibility();
        log(`NCCS API ${enabledToggle.checked ? 'enabled' : 'disabled'}.`, 'info');
    });

    enabledFakeStreamToggle.addEventListener('change', () => {
        saveSetting('nccsFakeStreamEnabled', enabledFakeStreamToggle.checked);
        log(`NCCS fake stream ${enabledFakeStreamToggle.checked ? 'enabled' : 'disabled'}.`, 'info');
    });

    if (modeSelect) {
        modeSelect.addEventListener('change', () => {
            saveSetting('nccsApiMode', modeSelect.value);
            updateModeBasedVisibility();
            if (modeSelect.value === 'sillytavern_preset') {
                loadSillyTavernPresets();
            }
            log(`NCCS API mode changed to ${modeSelect.value}.`, 'info');
        });
    }

    if (urlInput) {
        urlInput.addEventListener('blur', () => {
            saveSetting('nccsApiUrl', urlInput.value);
        });
    }

    if (keyInput) {
        keyInput.addEventListener('blur', () => {
            configManager.set('nccsApiKey', keyInput.value);
        });
    }

    if (modelInput) {
        const saveModel = () => saveSetting('nccsModel', modelInput.value);
        modelInput.addEventListener('blur', saveModel);
        modelInput.addEventListener('input', saveModel);
    }

    if (presetSelect) {
        presetSelect.addEventListener('change', () => {
            saveSetting('nccsTavernProfile', presetSelect.value);
        });
    }

    if (testButton) {
        testButton.addEventListener('click', async () => {
            testButton.disabled = true;
            testButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing...';

            try {
                const success = await testNccsApiConnection();
                if (success) {
                    toastr.success('NCCS API connection succeeded.');
                    log('NCCS API connection succeeded.', 'success');
                } else {
                    toastr.error('NCCS API connection failed.');
                    log('NCCS API connection failed.', 'error');
                }
            } catch (error) {
                toastr.error(`NCCS API test failed: ${error.message}`);
                log(`NCCS API test failed: ${error.message}`, 'error');
            } finally {
                testButton.disabled = false;
                testButton.innerHTML = '<i class="fas fa-plug"></i> Test Connection';
            }
        });
    }

    if (fetchModelsButton && modelInput) {
        fetchModelsButton.addEventListener('click', async () => {
            fetchModelsButton.disabled = true;
            fetchModelsButton.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Loading...';

            if (urlInput) {
                saveSetting('nccsApiUrl', urlInput.value);
            }
            if (keyInput) {
                configManager.set('nccsApiKey', keyInput.value);
            }

            try {
                const models = await fetchNccsModels();
                if (!models?.length) {
                    toastr.warning('No models returned.');
                    log('No NCCS models returned.', 'warn');
                    return;
                }

                let modelSelect = document.getElementById('nccs-api-model-select');
                if (!modelSelect) {
                    modelSelect = document.createElement('select');
                    modelSelect.id = 'nccs-api-model-select';
                    modelSelect.className = 'text_pole';
                    modelInput.parentNode.insertBefore(modelSelect, modelInput.nextSibling);
                }

                const currentModel = getLiveExtensionSettings().nccsModel;
                modelSelect.innerHTML = '<option value="">-- Select model --</option>';

                models.forEach((model) => {
                    const value = model.id || model.name;
                    const option = document.createElement('option');
                    option.value = value;
                    option.textContent = model.name || model.id;
                    option.selected = value === currentModel;
                    modelSelect.appendChild(option);
                });

                modelInput.style.display = 'none';
                modelSelect.style.display = 'block';
                modelSelect.onchange = () => {
                    const selectedModel = modelSelect.value;
                    modelInput.value = selectedModel;
                    saveSetting('nccsModel', selectedModel);
                };

                toastr.success(`Loaded ${models.length} models.`);
                log(`Loaded ${models.length} NCCS models.`, 'success');
            } catch (error) {
                toastr.error(`Failed to load models: ${error.message}`);
                log(`Failed to load NCCS models: ${error.message}`, 'error');
            } finally {
                fetchModelsButton.disabled = false;
                fetchModelsButton.innerHTML = '<i class="fas fa-download"></i> Fetch Models';
            }
        });
    }

    if (modeSelect?.value === 'sillytavern_preset' && presetSelect) {
        loadSillyTavernPresets();
    }

    log('NCCS API settings bound.', 'success');
}
