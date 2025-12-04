import { extension_settings } from '/scripts/extensions.js';
import { saveSettings, extensionName } from './settings.js';
import { updateUI } from '../ui/state.js';

// Force authorized status
export const pluginAuthStatus = { 'authorized': true, 'expired': false };

export function getPasswordForDate(date) {
    // Dummy implementation, no longer needed but kept for API compatibility
    return "00000000";
}

export function checkAuthorization() {
    // Always return true
    return true;
}

export async function activatePluginAuthorization(code) {
    // Always succeed
    toastr.success('授权激活成功！', 'Amily2号启用');
    pluginAuthStatus['authorized'] = true;
    return true;
}

export function displayExpiryInfo() {
    return '<div class="auth-status valid"><i class="fas fa-lock-open"></i> 授权有效期: 永久</div>';
}