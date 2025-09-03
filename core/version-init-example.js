
function initAmily2VersionDisplay() {
    console.log('[Amily2] 开始初始化版本显示功能...');

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(startVersionCheck, 2000);
        });
    } else {
        setTimeout(startVersionCheck, 2000);
    }
}

function startVersionCheck() {
    if (typeof window.amily2Updater !== 'undefined') {
        console.log('[Amily2] 版本检测器已加载，开始初始化...');
        window.amily2Updater.initialize();
    } else {
        console.warn('[Amily2] 版本检测器未找到，请确保 core/amily2-updater.js 已正确加载');

        setTimeout(() => {
            const $currentVersion = $('#amily2_current_version');
            const $latestVersion = $('#amily2_latest_version');
            
            if ($currentVersion.length && $currentVersion.text() === '加载中...') {
                $currentVersion.text('检测失败');
            }
            
            if ($latestVersion.length && $latestVersion.text() === '检查中...') {
                $latestVersion.text('检测失败');
            }
        }, 5000);
    }
}

function manualCheckVersion() {
    if (typeof window.amily2Updater !== 'undefined') {
        window.amily2Updater.manualCheck();
    } else {
        console.warn('[Amily2] 版本检测器不可用');
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        initAmily2VersionDisplay,
        manualCheckVersion
    };
}

if (typeof window !== 'undefined') {
    window.initAmily2VersionDisplay = initAmily2VersionDisplay;
    window.manualCheckVersion = manualCheckVersion;
}

/*
使用方法：

1. 在主扩展的初始化代码中调用：
   initAmily2VersionDisplay();

2. 在设置面板打开时手动检查：
   manualCheckVersion();

3. 确保在HTML中包含了版本显示的元素：
   <div id="amily2_current_version">加载中...</div>
   <div id="amily2_latest_version">检查中...</div>
*/
