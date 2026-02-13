import { eventSource, event_types, main_api, stopGeneration } from '/script.js';
import { renderExtensionTemplateAsync } from '/scripts/extensions.js';
import { POPUP_RESULT, POPUP_TYPE, Popup } from '/scripts/popup.js';
import { t } from '/scripts/i18n.js';
import { extensionName } from '../utils/settings.js';
import { getTokenCountAsync } from '/scripts/tokenizers.js';

window.MiZheSi_Global = {
    isEnabled: () => inspectEnabled,
};

const miZheSiPath = `third-party/${extensionName}/MiZheSi`;
const STORAGE_KEY = 'amily2_miZheSiEnabled';

if (!('GENERATE_AFTER_COMBINE_PROMPTS' in event_types) || !('CHAT_COMPLETION_PROMPT_READY' in event_types)) {
    toastr.error('【密折司】错误：您的SillyTavern版本过旧，缺少必要的事件支持。请更新至最新版本。');
    throw new Error('【密折司】缺少必要的事件支持。');
}

let inspectEnabled = false;

function addLaunchButton() {
    const enabledText = '关闭Amliy2号密折司';
    const disabledText = '开启Amliy2号密折司';
    const iconClass = 'fa-solid fa-scroll';

    const getText = () => inspectEnabled ? enabledText : disabledText;

    const launchButton = document.createElement('div');
    launchButton.id = 'miZheSiLaunchButton';
    launchButton.classList.add('list-group-item', 'flex-container', 'flexGap5', 'interactable');
    launchButton.tabIndex = 0;
    launchButton.title = '切换【密折司】状态';
    
    const icon = document.createElement('i');
    icon.className = iconClass;
    launchButton.appendChild(icon);

    const textSpan = document.createElement('span');
    textSpan.textContent = getText();
    launchButton.appendChild(textSpan);

    const extensionsMenu = document.getElementById('extensionsMenu');
    if (!extensionsMenu) {
        console.error('【密折司】无法找到左下角扩展菜单 (extensionsMenu)。');
        return;
    }

    if (document.getElementById(launchButton.id)) {
        return;
    }

    extensionsMenu.appendChild(launchButton);
    launchButton.addEventListener('click', () => {
        toggleInspectNext();
        textSpan.textContent = getText();
        launchButton.classList.toggle('active', inspectEnabled);
    });

    launchButton.classList.toggle('active', inspectEnabled);
}

function toggleInspectNext() {
    inspectEnabled = !inspectEnabled;
    toastr.info(`【密折司】已${inspectEnabled ? '开启' : '关闭'}`);
    localStorage.setItem(STORAGE_KEY, String(inspectEnabled));
}

async function showPromptInspector(input) {
    const template = $(await renderExtensionTemplateAsync(miZheSiPath, 'template'));
    const container = template.find('#mizhesi-editor-container');
    let isJsonMode = false;

    const titleHeader = template.find('.mizhesi-header h3');
    const charCountDisplay = $('<span id="mizhesi-char-count" style="font-size: 14px; color: #FFD700; margin-left: 15px; font-weight: normal;"></span>');
    titleHeader.append(charCountDisplay);

    const updateTotalCharCount = async () => {
        let totalTokens = 0;
        let totalChars = 0;
        if (isJsonMode) {
            const textareas = template.find('.mizhesi-message-textarea');
            for (const textarea of textareas) {
                const text = $(textarea).val();
                totalTokens += await getTokenCountAsync(text);
                totalChars += text.length;
            }
        } else {
            const text = template.find('#mizhesi-plain-text-editor').val();
            totalTokens = await getTokenCountAsync(text);
            totalChars = text.length;
        }
        charCountDisplay.text(`(总 ${totalTokens} Tokens / ${totalChars} 字)`);
    };

    try {
        const chat = JSON.parse(input);
        if (Array.isArray(chat)) {
            isJsonMode = true;
            container.empty(); // 清空容器
            for (const message of chat) {
                const block = $(`
                    <div class="mizhesi-message-block" data-role="${message.role}">
                        <div class="mizhesi-message-header">
                            <span class="mizhesi-injection-icons" style="display: inline-flex; gap: 5px; margin-right: 10px; align-items: center;"></span>
                            <span class="mizhesi-line-char-count" style="font-weight: normal; color: #FFD700; margin-right: 10px;"></span>
                            <span class="mizhesi-role">${message.role}</span>
                        </div>
                        <div class="mizhesi-message-content">
                            <textarea class="mizhesi-message-textarea"></textarea>
                        </div>
                    </div>
                `);

                let content = message.content;
                const iconsContainer = block.find('.mizhesi-injection-icons');

                // 【V11.0 升级】支持多种注入来源标记
                const injectionMarkers = {
                    '%%HANLINYUAN_RAG_NOVEL%%': {
                        icon: 'fa-book-open',
                        title: '翰林院注入 (小说)',
                        color: '#66ccff'
                    },
                    '%%HANLINYUAN_RAG_CHAT%%': {
                        icon: 'fa-comments',
                        title: '翰林院注入 (聊天记录)',
                        color: '#66ccff'
                    },
                    '%%HANLINYUAN_RAG_LOREBOOK%%': {
                        icon: 'fa-atlas',
                        title: '翰林院注入 (世界书)',
                        color: '#66ccff'
                    },
                    '%%HANLINYUAN_RAG_MANUAL%%': {
                        icon: 'fa-pencil-alt',
                        title: '翰林院注入 (手动)',
                        color: '#66ccff'
                    },
                    '%%AMILY2_TABLE_INJECTION%%': {
                        icon: 'fa-table-cells',
                        title: '表格系统注入',
                        color: '#99cc33'
                    }
                };

                for (const marker in injectionMarkers) {
                    if (content.includes(marker)) {
                        content = content.replace(marker, '');
                        const details = injectionMarkers[marker];
                        iconsContainer.append(`<i class="fa-solid ${details.icon}" title="${details.title}" style="color: ${details.color};"></i>`);
                    }
                }

                const textarea = block.find('textarea');
                textarea.val(content);
                container.append(block);

                const lineCharCountDisplay = block.find('.mizhesi-line-char-count');
                const updateLineCharCount = async () => {
                    const text = textarea.val();
                    const lineTokens = await getTokenCountAsync(text);
                    const lineChars = text.length;
                    lineCharCountDisplay.text(`(${lineTokens} Tokens / ${lineChars} 字)`);
                };

                await updateLineCharCount(); // 初始化行字数
                textarea.on('input', async () => {
                    await updateLineCharCount();
                    await updateTotalCharCount();
                });

                block.find('.mizhesi-message-header').on('click', function(e) {
                    if ($(e.target).is('.mizhesi-line-char-count, .mizhesi-injection-icons, .mizhesi-injection-icons *')) {
                        e.stopPropagation(); // 防止点击字数或图标时折叠
                        return;
                    }
                    const content = $(this).siblings('.mizhesi-message-content');
                    const parentBlock = $(this).closest('.mizhesi-message-block');
                    parentBlock.toggleClass('expanded');
                    content.slideToggle('fast');
                });
            }
        } else {
            throw new Error("Input is not a chat array.");
        }
    } catch (e) {
        isJsonMode = false;
        const textArea = $('<textarea id="mizhesi-plain-text-editor" style="width: 100%; height: 100%; box-sizing: border-box;"></textarea>');
        textArea.val(input);
        container.empty().append(textArea);
        textArea.on('input', async () => await updateTotalCharCount());
    }

    await updateTotalCharCount(); // 初始化总字数

    const searchInput = template.find('#mizhesi-search-input');
    const searchButton = template.find('#mizhesi-search-button');
    const clearButton = template.find('#mizhesi-clear-button');

    const performSearch = () => {
        const searchTerm = searchInput.val().trim();
        if (!searchTerm) return;

        clearHighlights();

        let firstMatch = null;
        const textareas = template.find('.mizhesi-message-textarea, #mizhesi-plain-text-editor');

        textareas.each(function() {
            const textarea = $(this);
            const content = textarea.val();
            const regex = new RegExp(searchTerm.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
            
            if (regex.test(content)) {
                textarea.addClass('mizhesi-highlight-border');
                if (!firstMatch) {
                    firstMatch = textarea;
                }

                const block = textarea.closest('.mizhesi-message-block');
                if (block.length && !block.hasClass('expanded')) {
                    block.addClass('expanded');
                    block.find('.mizhesi-message-content').slideDown('fast');
                }
            }
        });

        if (firstMatch) {
            firstMatch[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            toastr.info('【密折司】未找到匹配项。');
        }
    };

    const clearHighlights = () => {
        template.find('.mizhesi-highlight-border').removeClass('mizhesi-highlight-border');
    };

    searchButton.on('click', performSearch);
    searchInput.on('keypress', (e) => {
        if (e.which === 13) { // Enter key
            performSearch();
        }
    });
    clearButton.on('click', clearHighlights);


    const customButton = {
        text: '取消生成',
        result: POPUP_RESULT.CANCELLED,
        appendAtEnd: true,
        action: async () => {
            await stopGeneration();
            await popup.complete(POPUP_RESULT.CANCELLED);
        },
    };

    const popup = new Popup(template, POPUP_TYPE.CONFIRM, '', { 
        wide: true, 
        large: true, 
        okButton: '确认修改', 
        cancelButton: '放弃修改', 
        customButtons: [customButton] 
    });

    const result = await popup.show();

    if (!result) {
        return input; // 用户取消，返回原始输入
    }

    if (isJsonMode) {
        const newChat = [];
        template.find('.mizhesi-message-block').each(function() {
            const role = $(this).data('role');
            const content = $(this).find('textarea').val();
            newChat.push({ role, content });
        });
        return JSON.stringify(newChat, null, 4);
    } else {
        return template.find('#mizhesi-plain-text-editor').val();
    }
}

function isChatCompletion() {
    return main_api === 'openai';
}

eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, async (data) => {
    if (!inspectEnabled || data.dryRun || isChatCompletion()) return;
    if (typeof data.prompt !== 'string') return;

    const result = await showPromptInspector(data.prompt);
    if (result !== data.prompt) {
        data.prompt = result;
        console.log('【密折司】奏章已按御笔修改 (Text Gen)。');
    }
});

eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, async (data) => {
    if (!inspectEnabled || data.dryRun || !isChatCompletion()) return;
    if (!Array.isArray(data.chat)) return;

    const originalJson = JSON.stringify(data.chat, null, 4);
    const resultJson = await showPromptInspector(originalJson);

    if (resultJson === originalJson) return;

    try {
        const modifiedChat = JSON.parse(resultJson);
        data.chat.splice(0, data.chat.length, ...modifiedChat);
        console.log('【密折司】奏章已按御笔修改 (Chat Completion)。');
    } catch (e) {
        console.error('【密折司】解析修改后的JSON奏章失败:', e);
        toastr.error('【密折司】解析JSON失败，本次修改未生效。');
    }
});

addLaunchButton();
