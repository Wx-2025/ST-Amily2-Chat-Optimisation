// Side-effect imports (独立模块/自初始化模块)
import "./PresetSettings/index.js";
import "./PreOptimizationViewer/index.js";
import "./WorldEditor/WorldEditor.js";
import './core/amily2-updater.js';
import './SL/bus/Amily2Bus.js'

// Re-exports (重新导出供 index.js 使用)
export { createDrawer } from "./ui/drawer.js";
export { showPlotOptimizationProgress, updatePlotOptimizationProgress, hidePlotOptimizationProgress } from './ui/optimization-progress.js';
export { registerSlashCommands } from "./core/commands.js";
export { onMessageReceived, handleTableUpdate } from "./core/events.js";
export { processPlotOptimization } from "./core/summarizer.js";

// External SillyTavern scripts (外部脚本)
export { getContext, extension_settings } from "/scripts/extensions.js";
export { characters, this_chid, eventSource, event_types, saveSettingsDebounced } from '/script.js';

// Core Systems
export { injectTableData, generateTableContent } from "./core/table-system/injector.js";
export { initialize as initializeRagProcessor } from "./core/rag-processor.js";
export { loadTables, clearHighlights, rollbackAndRefill, rollbackState, commitPendingDeletions, saveStateToMessage, getMemoryState, clearUpdatedTables } from './core/table-system/manager.js';
export { fillWithSecondaryApi } from './core/table-system/secondary-filler.js';
export { renderTables } from './ui/table-bindings.js';
export { log } from './core/table-system/logger.js';
export { checkForUpdates, fetchMessageBoardContent } from './core/api.js';
export { setUpdateInfo, applyUpdateIndicator } from './ui/state.js';
export { pluginVersion, extensionName, defaultSettings } from './utils/settings.js';
export { checkAuthorization, refreshUserInfo } from './utils/auth.js';
export { tableSystemDefaultSettings } from './core/table-system/settings.js';
export { manageLorebookEntriesForChat } from './core/lore.js';

// Feature Modules
export { initializeCharacterWorldBook } from './CharacterWorldBook/cwb_index.js';
export { cwbDefaultSettings } from './CharacterWorldBook/src/cwb_config.js';
export { bindGlossaryEvents } from './glossary/GT_bindings.js';
export { updateOrInsertTableInChat, startContinuousRendering, stopContinuousRendering } from './ui/message-table-renderer.js';
export { initializeRenderer } from './core/tavern-helper/renderer.js';
export { initializeApiListener, registerApiHandler, amilyHelper, initializeAmilyHelper } from './core/tavern-helper/main.js';
export { registerContextOptimizerMacros, resetContextBuffer } from './core/context-optimizer.js';
export { initializeSuperMemory } from './core/super-memory/manager.js';
