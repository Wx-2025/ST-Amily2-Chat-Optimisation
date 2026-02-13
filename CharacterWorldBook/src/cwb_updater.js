import { showToastr } from './cwb_utils.js';

const { SillyTavern } = window;

const GIT_REPO_OWNER = 'Wx-2025';
const GIT_REPO_NAME = 'ST-Amily2-Chat-Optimisation';
const EXTENSION_NAME = 'ST-Amily2-Chat-Optimisation'; 
const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/${EXTENSION_NAME}`;

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
        return JSON.parse(content).version || '0.0.0';
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

async function performUpdate() {
    const { getRequestHeaders } = SillyTavern.getContext().common;
    const { extension_types } = SillyTavern.getContext().extensions;
    showToastr('info', '正在开始更新主扩展...');
    try {
        const response = await fetch('/api/extensions/update', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                extensionName: EXTENSION_NAME,
                global: extension_types[EXTENSION_NAME] === 'global',
            }),
        });
        if (!response.ok) throw new Error(await response.text());

        showToastr('success', '更新成功！将在3秒后刷新页面应用更改。');
        setTimeout(() => location.reload(), 3000);
    } catch (error) {
        showToastr('error', `更新失败: ${error.message}`);
    }
}

async function showUpdateConfirmDialog() {
    const { POPUP_TYPE, callGenericPopup } = SillyTavern;
    try {
        changelogContent = await fetchRawFileFromGitHub('CHANGELOG.md');
    } catch (error) {
        changelogContent = `发现新版本 ${latestVersion}！您想现在更新吗？`;
    }
    if (
        await callGenericPopup(changelogContent, POPUP_TYPE.CONFIRM, {
            okButton: '立即更新',
            cancelButton: '稍后',
            wide: true,
            large: true,
        })
    ) {
        await performUpdate();
    }
}

export async function checkForUpdates(isManual = false, $panel) {
    if (!$panel) return;
    const $updateButton = $panel.find('#cwb-check-for-updates');
    const $updateIndicator = $panel.find('.cwb-update-indicator');

    if (isManual) {
        $updateButton.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 检查中...');
    }
    try {
        const localManifestText = await (await fetch(`/${EXTENSION_FOLDER_PATH}/manifest.json?t=${Date.now()}`)).text();
        currentVersion = parseVersion(localManifestText);
        $panel.find('#cwb-current-version').text(currentVersion);

        const remoteManifestText = await fetchRawFileFromGitHub('manifest.json');
        latestVersion = parseVersion(remoteManifestText);

        if (compareVersions(latestVersion, currentVersion) > 0) {
            $updateIndicator.show();
            $updateButton
                .html(`<i class="fa-solid fa-gift"></i> 发现新版 ${latestVersion}!`)
                .off('click')
                .on('click', () => showUpdateConfirmDialog());
            if (isManual) showToastr('success', `发现新版本 ${latestVersion}！点击按钮进行更新。`);
        } else {
            $updateIndicator.hide();
            if (isManual) showToastr('info', '您当前已是最新版本。');
        }
    } catch (error) {
        if (isManual) showToastr('error', `检查更新失败: ${error.message}`);
    } finally {
        if (isManual && compareVersions(latestVersion, currentVersion) <= 0) {
            $updateButton.prop('disabled', false).html('<i class="fa-solid fa-cloud-arrow-down"></i> 检查更新');
        }
    }
}
