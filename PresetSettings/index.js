import * as state from './prese_state.js';
import * as ui from './prese_ui.js';

// Public API for other modules
export { getPresetPrompts, getMixedOrder } from './prese_state.js';

// Initialize the application
$(document).ready(function() {
    state.loadPresets();
    ui.addPresetSettingsButton();
});
