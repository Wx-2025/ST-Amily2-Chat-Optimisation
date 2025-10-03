import { loadSettings, bindSettingsEvents } from './src/cwb_settingsManager.js';
import { initializeCharCardViewer, bindCwbApiEvents } from './src/cwb_uiManager.js';
import { initializeCore, getLatestChatName, resetScriptStateForNewChat, handleMessageReceived, updateCardUpdateStatusDisplay } from './src/cwb_core.js';
import { checkForUpdates } from './src/cwb_updater.js';
import { isCwbEnabled } from './src/cwb_utils.js';
import { eventSource, event_types } from '/script.js';

const { jQuery } = window;

export async function initializeCharacterWorldBook($cwbSettingsPanel) {
    try {
        if (!$cwbSettingsPanel || !$cwbSettingsPanel.length) {
            console.error('[CWB] Invalid settings panel provided for initialization.');
            return;
        }

        bindSettingsEvents($cwbSettingsPanel);
        bindCwbApiEvents();
        loadSettings();
        initializeCharCardViewer();

        // Always update status display on initialization
        updateCardUpdateStatusDisplay($cwbSettingsPanel);

        if (isCwbEnabled()) {
            console.log('[CWB] Master switch is enabled. Initializing core features.');
            checkForUpdates(false, $cwbSettingsPanel);
            await initializeCore($cwbSettingsPanel);
        } else {
            console.log('[CWB] Master switch is disabled. Halting core feature initialization.');
        }

        eventSource.on(event_types.CHAT_CHANGED, async () => {
            console.log('[CWB] Detected chat change. Resetting state and updating UI.');
            setTimeout(async () => {
                const newChatName = await getLatestChatName();
                await resetScriptStateForNewChat($cwbSettingsPanel, newChatName);
                updateCardUpdateStatusDisplay($cwbSettingsPanel);
            }, 150);
        });

        eventSource.on(event_types.MESSAGE_RECEIVED, () => {
            handleMessageReceived($cwbSettingsPanel);
            updateCardUpdateStatusDisplay($cwbSettingsPanel);
        });

        console.log('[CWB] Character World Book feature initialized successfully.');

    } catch (error) {
        console.error('[CWB] A critical error occurred during initialization:', error);
    }
}
