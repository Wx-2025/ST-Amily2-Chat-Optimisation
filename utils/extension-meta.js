// Keep extension identity independent from settings/auth/config side effects.
// Modules needed during bootstrap may safely import this file without creating
// an evaluation cycle through utils/settings.js.
const settingsUrl = new URL(import.meta.url);
const pathParts = settingsUrl.pathname.split('/');
const thirdPartyIndex = pathParts.indexOf('third-party');

export const extensionName = thirdPartyIndex >= 0
    ? pathParts[thirdPartyIndex + 1]
    : 'ST-Amily2-Chat-Optimisation';

export const extensionBasePath = new URL('..', import.meta.url).href.replace(/\/$/, '');
