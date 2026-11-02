import { getContext } from '/scripts/extensions.js';
import { readProgressiveMemoryRuleDependencies } from '../progressive-memory/rule-dependencies.js';
import { getCurrentIndexWorldbookRuntime } from './index-worldbook-host.js';
import { INDEX_WORLDBOOK_CONFIG_KEY } from './index-worldbook-config.js';
import { captureIndexDependencies } from './index-dependencies.js';

export function readCurrentIndexDependencies(table) {
    try {
        const runtime = getCurrentIndexWorldbookRuntime();
        // A missing runtime cannot prove an existing mapping is disabled.
        if (!runtime && getContext()?.chatMetadata?.[INDEX_WORLDBOOK_CONFIG_KEY] != null) {
            throw new Error('Worldbook dependency reader unavailable.');
        }
        return captureIndexDependencies(table, {
            rules: readProgressiveMemoryRuleDependencies({ tableId: table.id, groupId: table.groupId }),
            worldbook: runtime?.listDependencies(table.id) ?? [],
        });
    } catch {
        throw Object.assign(new Error('INDEX_DEPENDENCIES_UNAVAILABLE'), { code: 'INDEX_DEPENDENCIES_UNAVAILABLE' });
    }
}
