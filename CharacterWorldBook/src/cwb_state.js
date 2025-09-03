
export const SCRIPT_ID_PREFIX = 'cwb';
export const CHAR_CARD_VIEWER_BUTTON_ID = `${SCRIPT_ID_PREFIX}-viewer-button`;
export const CHAR_CARD_VIEWER_POPUP_ID = `${SCRIPT_ID_PREFIX}-viewer-popup`;
export const NEW_MESSAGE_DEBOUNCE_DELAY = 4000;
export const MIN_POLLING_INTERVAL = 10000;
export const MAX_POLLING_INTERVAL = 100000;
export const POLLING_INTERVAL_STEP = 10000;

export const state = {
    masterEnabled: false, 

    customApiConfig: { url: '', apiKey: '', model: '' },

    currentBreakArmorPrompt: '',
    currentCharCardPrompt: '',
    currentIncrementalCharCardPrompt: '',

    autoUpdateThreshold: null,
    autoUpdateEnabled: null,

    viewerEnabled: null,
    isIncrementalUpdateEnabled: null,
    worldbookTarget: 'primary',
    customWorldBook: null,

    isAutoUpdatingCard: false,
    newMessageDebounceTimer: null,
    pollingTimer: null,
    currentPollingInterval: MIN_POLLING_INTERVAL,
    allChatMessages: [],
    currentChatFileIdentifier: 'unknown_chat_init',
};
