const getLogContainer = () => document.getElementById('table-log-display');

export function log(message, type = 'info', data = null) {
    const container = getLogContainer();
    if (!container) {
        // 在容器不可用时，静默地将日志打印到控制台，不再显示警告
        const logFunc = console[type] || console.log;
        logFunc(`[内存储司-起居注] ${message}`, data || '');
        return;
    }

    const iconMap = {
        info: 'fa-solid fa-circle-info',
        success: 'fa-solid fa-check-circle',
        warn: 'fa-solid fa-triangle-exclamation',
        error: 'fa-solid fa-circle-xmark',
    };

    const logEntry = document.createElement('p');
    logEntry.className = `hly-log-entry log-${type}`;
    const icon = document.createElement('i');
    icon.className = iconMap[type];
    logEntry.appendChild(icon);
    logEntry.appendChild(document.createTextNode(` ${message}`));

    container.appendChild(logEntry);

    // Auto-scroll to the bottom
    container.scrollTop = container.scrollHeight;
}
