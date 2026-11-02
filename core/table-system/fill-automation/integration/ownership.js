import { normalizeFillAutomationConfig } from '../config.js';

// Read-only and usable before the runtime is initialized. Invalid configuration stops the old writer too.
export function isTableOwnedByAutomation(tableId, context) {
    const config = normalizeFillAutomationConfig(context?.chatMetadata?.amily2_fill_automation_config_v1);
    const binding = config.bindings.find(item => item.tableId === tableId);
    return !!binding && (binding.mode === 'profile' || binding.cycle.mode !== 'inherit');
}

export function getAutomationOwnedTableIds(context) {
    const config = normalizeFillAutomationConfig(context?.chatMetadata?.amily2_fill_automation_config_v1);
    return Object.freeze(config.bindings.filter(binding => binding.mode === 'profile' || binding.cycle.mode !== 'inherit')
        .map(binding => binding.tableId));
}
