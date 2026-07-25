const GIT_REPO_OWNER = 'Wx-2025';
const GIT_REPO_NAME = 'ST-Amily2-Chat-Optimisation';
import { extensionName } from '../utils/settings.js';
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
            const version = String(JSON.parse(content).version ?? '');
            return /^\d+\.\d+\.\d+$/.test(version) ? version : '0.0.0';
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

    openUpdateReviewPage() {
        const link = document.createElement('a');
        link.href = UPDATE_REVIEW_URL;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.click();
        this.showToast('info', '已打开提交记录；请核对发布内容后通过 SillyTavern 扩展管理器手动更新。');
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
                    asPlainTextPopupContent(logContent),
                    POPUP_TYPE.CONFIRM,
                    {
                        okButton: '查看提交记录',
                        cancelButton: '稍后',
                        wide: true,
                        large: true,
                    }
                );

                if (confirmed) {
                    this.openUpdateReviewPage();
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
                asPlainTextPopupContent(basicContent),
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
            this.changelogContent = `发现新版本 ${this.latestVersion}！\n\n请先核对提交记录，再通过 SillyTavern 扩展管理器手动更新。`;
        }

        const confirmed = await callGenericPopup(
            asPlainTextPopupContent(this.changelogContent),
            POPUP_TYPE.CONFIRM,
            {
                okButton: '查看提交记录',
                cancelButton: '稍后',
                wide: true,
                large: true,
            }
        );

        if (confirmed) {
            this.openUpdateReviewPage();
        }
    }

    updateUI() {
        this.updateVersionDisplay();

        const $updateButton = $('#amily2_update_button');
        const $updateButtonNew = $('#amily2_update_button_new');
        const $updateIndicator = $('#amily2_update_indicator');

        if (this.compareVersions(this.latestVersion, this.currentVersion) > 0) {
            const safeVersion = /^[\w.+\-]{1,40}$/.test(String(this.latestVersion ?? '')) ? this.latestVersion : '未知';
            $updateIndicator.show();
            $updateButton.attr('title', `发现新版本 ${safeVersion}！点击查看详情`);
            // 经典首页：中间「更新」按钮显示礼物 + 新版号
            $updateButtonNew
                .attr('title', `升级到 ${safeVersion}`)
                .attr('data-amily2-upgrade-bound', '1')
                .data('amily2-upgrade-bound', 1)
                .empty()
                .append($('<i>').addClass('fas fa-gift'))
                .append(document.createTextNode(` 新版 ${safeVersion}`))
                .show()
                .off('click.amily2Upgrade')
                .on('click.amily2Upgrade', (e) => {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    this.showUpdateConfirmDialog();
                });
        } else {
            $updateIndicator.hide();
            $updateButton.attr('title', `当前版本 ${this.currentVersion}（已是最新）`);
            $updateButtonNew
                .attr('title', '已是最新版本')
                .removeAttr('data-amily2-upgrade-bound')
                .removeData('amily2-upgrade-bound')
                .hide()
                .off('click.amily2Upgrade');
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
                    this.showToast('success', `发现新版本 ${this.latestVersion}！请先查看提交记录，再手动更新。`);
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
