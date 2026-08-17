import {
    pluginAuthStatus,
    subscribePluginAuthStatus,
} from '../../utils/auth-state.js';

export const SUPER_MEMORY_MIN_USER_TYPE = 1;

export function getSuperMemoryAccessDecision(authState = pluginAuthStatus) {
    const authorized = authState?.authorized === true;
    const expired = authState?.expired === true;
    const userType = Number(authState?.userType);
    const revision = Number(authState?.revision);
    const allowed = authorized
        && !expired
        && Number.isSafeInteger(userType)
        && userType >= SUPER_MEMORY_MIN_USER_TYPE;

    return Object.freeze({
        allowed,
        authorized,
        expired,
        userType: Number.isSafeInteger(userType) ? userType : 0,
        revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
        minUserType: SUPER_MEMORY_MIN_USER_TYPE,
        reason: allowed
            ? 'allowed'
            : (!authorized
                ? 'authorization-required'
                : (expired ? 'authorization-expired' : 'type1-required')),
    });
}

export function hasSuperMemoryAccess(authState = pluginAuthStatus) {
    return getSuperMemoryAccessDecision(authState).allowed;
}

export function subscribeSuperMemoryAccess(listener) {
    if (typeof listener !== 'function') return () => {};
    return subscribePluginAuthStatus(transition => {
        listener(getSuperMemoryAccessDecision(transition));
    });
}
