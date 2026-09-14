import { t, cwbLabel, setCwbHtml } from './cwb_i18n.js';
import { showToastr } from './cwb_utils.js';

const { SillyTavern } = window;

const GIT_REPO_OWNER = 'Wx-2025';
import { extensionName } from '../../utils/settings.js';
const GIT_REPO_NAME = 'ST-Amily2-Chat-Optimisation';
const EXTENSION_NAME = extensionName;
const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/${EXTENSION_NAME}`;
const UPDATE_REVIEW_URL = `https://github.com/${GIT_REPO_OWNER}/${GIT_REPO_NAME}/commits/main`;

function asPlainTextPopupContent(content) {
    const escaped = String(content ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    })[character]);
    return `<pre style="white-space: pre-wrap; word-break: break-word;">${escaped}</pre>`;
}

let currentVersion = '0.0.0';
let latestVersion = '0.0.0';
let changelogContent = '';

async function fetchRawFileFromGitHub(filePath) {
    const url = `https://raw.githubusercontent.com/${GIT_REPO_OWNER}/${GIT_REPO_NAME}/main/${filePath}`;
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
        throw new Error(`Failed to fetch ${filePath} from GitHub: ${response.statusText}`);
    }
    return response.text();
}

function parseVersion(content) {
    try {
        const version = String(JSON.parse(content).version ?? '');
        return /^\d+\.\d+\.\d+$/.test(version) ? version : '0.0.0';
    } catch (error) {
        console.error(`[cwb_updater] Failed to parse version:`, error);
        return '0.0.0';
    }
}

function compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2) return 1;
        if (p1 < p2) return -1;
    }
    return 0;
}

function openUpdateReviewPage() {
    const link = document.createElement('a');
    link.href = UPDATE_REVIEW_URL;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.click();
    showToastr('info', t('characterWorldUi.updater.opened'));
}

async function showUpdateConfirmDialog() {
    const { POPUP_TYPE, callGenericPopup } = SillyTavern;
    try {
        changelogContent = await fetchRawFileFromGitHub('CHANGELOG.md');
    } catch (error) {
        changelogContent = t('characterWorldUi.updater.fallback', { version: latestVersion });
    }
    if (
        await callGenericPopup(asPlainTextPopupContent(changelogContent), POPUP_TYPE.CONFIRM, {
            okButton: t('characterWorldUi.updater.review'),
            cancelButton: t('characterWorldUi.updater.later'),
            wide: true,
            large: true,
        })
    ) {
        openUpdateReviewPage();
    }
}

export async function checkForUpdates(isManual = false, $panel) {
    if (!$panel) return;
    const $updateButton = $panel.find('#cwb-check-for-updates');
    const $updateIndicator = $panel.find('.cwb-update-indicator');

    if (isManual) {
        setCwbHtml($updateButton.prop('disabled', true), '<i class="fas fa-spinner fa-spin"></i> ' + cwbLabel('characterWorldUi.updater.checking'));
    }
    try {
        const localManifestText = await (await fetch(`/${EXTENSION_FOLDER_PATH}/manifest.json?t=${Date.now()}`)).text();
        currentVersion = parseVersion(localManifestText);
        $panel.find('#cwb-current-version').text(currentVersion);

        const remoteManifestText = await fetchRawFileFromGitHub('manifest.json');
        latestVersion = parseVersion(remoteManifestText);

        if (compareVersions(latestVersion, currentVersion) > 0) {
            $updateIndicator.show();
            setCwbHtml($updateButton, '<i class="fa-solid fa-gift"></i> ' + cwbLabel('characterWorldUi.updater.available', { version: latestVersion }))
                .off('click')
                .on('click', () => showUpdateConfirmDialog());
            if (isManual) showToastr('success', t('characterWorldUi.updater.found', { version: latestVersion }));
        } else {
            $updateIndicator.hide();
            if (isManual) showToastr('info', t('characterWorldUi.updater.current'));
        }
    } catch (error) {
        if (isManual) showToastr('error', t('characterWorldUi.updater.failed', { error: error.message }), { escapeHtml: true });
    } finally {
        if (isManual && compareVersions(latestVersion, currentVersion) <= 0) {
            setCwbHtml($updateButton.prop('disabled', false), '<i class="fa-solid fa-cloud-arrow-down"></i> ' + cwbLabel('characterWorldUi.updater.check'));
        }
    }
}
