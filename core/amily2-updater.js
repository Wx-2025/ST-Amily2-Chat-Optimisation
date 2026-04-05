const GIT_REPO_OWNER = 'Wx-2025';
const GIT_REPO_NAME = 'ST-Amily2-Chat-Optimisation';
import { extensionName } from '../utils/settings.js';
const EXTENSION_NAME = extensionName;
const EXTENSION_FOLDER_PATH = `scripts/extensions/third-party/${EXTENSION_NAME}`;

class Amily2Updater {
    constructor() {
        this.currentVersion = '0.0.0';
        this.latestVersion = '0.0.0';
        this.changelogContent = '';
        this.isChecking = false;
    }

    async fetchRawFileFromGitHub(filePath) {
        const url = `https://raw.githubusercontent.com/${GIT_REPO_OWNER}/${GIT_REPO_NAME}/main/${filePath}`;
        const response = await fetch(url, { cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`获取文件失败 ${filePath}: ${response.statusText}`);
        }
        return response.text();
    }

    parseVersion(content) {
        try {
            return JSON.parse(content).version || '0.0.0';
        } catch (error) {
            console.error(`[Amily2Updater] 版本解析失败:`, error);
            return '0.0.0';
        }
    }

    compareVersions(v1, v2) {
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

    showToast(type, message) {

        if (typeof toastr !== 'undefined') {
            toastr[type](message);
        } else {
            console.log(`[${type.toUpperCase()}] ${message}`);
        }
    }

    async performUpdate() {
        const { getRequestHeaders } = SillyTavern.getContext().common;
        const { extension_types } = SillyTavern.getContext().extensions;
        
        this.showToast('info', '正在更新 Amily2号优化助手...');
        
        try {
            const response = await fetch('/api/extensions/update', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    extensionName: EXTENSION_NAME,
                    global: extension_types[EXTENSION_NAME] === 'global',
                }),
            });
            
            if (!response.ok) {
                throw new Error(await response.text());
            }

            this.showToast('success', '更新成功！将在3秒后刷新页面应用更改。');
            setTimeout(() => location.reload(), 3000);
        } catch (error) {
            this.showToast('error', `更新失败: ${error.message}`);
            throw error;
        }
    }

    async showUpdateLogDialog() {
        const { POPUP_TYPE, callGenericPopup } = SillyTavern;
        
        try {
            const updateInfoText = await this.fetchRawFileFromGitHub('amily2_update_info.json');
            const updateInfo = JSON.parse(updateInfoText);
            
            let logContent = `📋 Amily2号优化助手 - 更新日志\n\n`;
            logContent += `当前版本: ${this.currentVersion}\n`;
            logContent += `最新版本: ${this.latestVersion}\n\n`;
            
            if (updateInfo.changelog) {
                logContent += updateInfo.changelog;
            } else {
                logContent += "暂无更新日志内容。";
            }

            const hasUpdate = this.compareVersions(this.latestVersion, this.currentVersion) > 0;
            
            if (hasUpdate) {
                const confirmed = await callGenericPopup(
                    logContent,
                    POPUP_TYPE.CONFIRM,
                    {
                        okButton: '立即更新',
                        cancelButton: '稍后',
                        wide: true,
                        large: true,
                    }
                );

                if (confirmed) {
                    await this.performUpdate();
                }
            } else {
                await callGenericPopup(
                    logContent,
                    POPUP_TYPE.TEXT,
                    {
                        okButton: '知道了',
                        wide: true,
                        large: true,
                    }
                );
            }
            
        } catch (error) {
            console.error('[Amily2Updater] 获取更新日志失败:', error);
            const basicContent = `📋 Amily2号优化助手 - 版本信息\n\n`;
            basicContent += `当前版本: ${this.currentVersion}\n`;
            basicContent += `最新版本: ${this.latestVersion}\n\n`;
            basicContent += `无法获取详细更新日志: ${error.message}`;
            
            await callGenericPopup(
                basicContent,
                POPUP_TYPE.TEXT,
                {
                    okButton: '知道了',
                    wide: true,
                    large: true,
                }
            );
        }
    }

    async showUpdateConfirmDialog() {
        const { POPUP_TYPE, callGenericPopup } = SillyTavern;
        
        try {
            this.changelogContent = await this.fetchRawFileFromGitHub('CHANGELOG.md');
        } catch (error) {
            this.changelogContent = `发现新版本 ${this.latestVersion}！\n\n您想现在更新吗？`;
        }

        const confirmed = await callGenericPopup(
            this.changelogContent,
            POPUP_TYPE.CONFIRM,
            {
                okButton: '立即更新',
                cancelButton: '稍后',
                wide: true,
                large: true,
            }
        );

        if (confirmed) {
            await this.performUpdate();
        }
    }

    updateUI() {
        this.updateVersionDisplay();

        const $updateButton = $('#amily2_update_button');
        const $updateButtonNew = $('#amily2_update_button_new');
        const $updateIndicator = $('#amily2_update_indicator');

        if (this.compareVersions(this.latestVersion, this.currentVersion) > 0) {
            $updateIndicator.show();
            $updateButton.attr('title', `发现新版本 ${this.latestVersion}！点击查看详情`);
            $updateButtonNew
                .show()
                .html(`<i class="fas fa-gift"></i> 新版 ${this.latestVersion}`)
                .off('click')
                .on('click', () => this.showUpdateConfirmDialog());
        } else {
            $updateIndicator.hide();
            $updateButton.attr('title', `当前版本 ${this.currentVersion}（已是最新）`);
            $updateButtonNew.hide();
        }
    }
    
    updateVersionDisplay() {

        const $currentVersion = $('#amily2_current_version');
        if ($currentVersion.length) {
            $currentVersion.text(this.currentVersion || '未知');
        }

        const $latestVersion = $('#amily2_latest_version');
        const $latestContainer = $latestVersion.closest('.version-latest');
        
        if ($latestVersion.length) {
            $latestVersion.text(this.latestVersion || '获取失败');

            if (this.compareVersions(this.latestVersion, this.currentVersion) > 0) {
                $latestContainer.addClass('has-update');
            } else {
                $latestContainer.removeClass('has-update');
            }
        }
    }

    async checkForUpdates(isManual = false) {
        if (this.isChecking) return;
        
        this.isChecking = true;
        const $updateButton = $('#amily2_update_button');
        const $latestVersion = $('#amily2_latest_version');

        if ($latestVersion.length) {
            $latestVersion.text('检查中...');
        }
        
        if (isManual) {
            $updateButton.html('<i class="fas fa-spinner fa-spin"></i>').prop('disabled', true);
        }

        try {
            const localManifestText = await (
                await fetch(`/${EXTENSION_FOLDER_PATH}/manifest.json?t=${Date.now()}`)
            ).text();
            this.currentVersion = this.parseVersion(localManifestText);

            const $currentVersion = $('#amily2_current_version');
            if ($currentVersion.length) {
                $currentVersion.text(this.currentVersion || '未知');
            }

            const remoteManifestText = await this.fetchRawFileFromGitHub('manifest.json');
            this.latestVersion = this.parseVersion(remoteManifestText);

            this.updateUI();

            console.log(`[Amily2Updater] 版本检查完成 - 当前: ${this.currentVersion}, 最新: ${this.latestVersion}`);

            if (isManual) {
                if (this.compareVersions(this.latestVersion, this.currentVersion) > 0) {
                    this.showToast('success', `发现新版本 ${this.latestVersion}！点击"更新"按钮进行升级。`);
                } else {
                    this.showToast('info', '您当前已是最新版本。');
                }
            }
        } catch (error) {
            console.error('[Amily2Updater] 检查更新失败:', error);

            if ($latestVersion.length) {
                $latestVersion.text('获取失败');
            }
            
            if (isManual) {
                this.showToast('error', `检查更新失败: ${error.message}`);
            }
        } finally {
            this.isChecking = false;
            if (isManual) {
                $updateButton.html('<i class="fas fa-bell"></i>').prop('disabled', false);
            }
        }
    }

    initialize() {
        const $updateButton = $('#amily2_update_button');
        const $updateButtonNew = $('#amily2_update_button_new');
        $updateButton.off('click').on('click', () => {
            this.showUpdateLogDialog();
        });

        this.checkForUpdates(false);

        setInterval(() => {
            this.checkForUpdates(false);
        }, 30 * 60 * 1000);
    }

    async manualCheck() {
        await this.checkForUpdates(true);
    }

    getVersionInfo() {
        return {
            current: this.currentVersion,
            latest: this.latestVersion,
            hasUpdate: this.compareVersions(this.latestVersion, this.currentVersion) > 0
        };
    }
}

window.amily2Updater = new Amily2Updater();

export default window.amily2Updater;
