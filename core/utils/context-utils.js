
'use strict';

const migrationNoticeShown = new Set();

export function getCharacterId() {
    const context = SillyTavern.getContext();
    if (!context) return null;
    if (context.characterId !== undefined && context.characterId !== null) return context.characterId;
    if (typeof this_chid !== 'undefined' && this_chid !== null) return this_chid;
    if (context.chat && context.chat.length > 0) {
        const lastMessage = context.chat[context.chat.length - 1];
        if (lastMessage && lastMessage.character_id !== undefined) return lastMessage.character_id;
    }
    console.error('[翰林院-典籍库] 无法稳定获取当前角色ID。');
    return null;
}


export function getChatId() {
    const context = SillyTavern.getContext();
    if (!context) return null;
    if (typeof context.getCurrentChatId === 'function') return context.getCurrentChatId();
    if (context.chatId) return context.chatId;
    const charId = getCharacterId();
    if (charId !== null && context.characters && context.characters[charId]) {
        return context.characters[charId].chat;
    }
    console.error('[翰林院-典籍库] 无法稳定获取当前聊天ID。');
    return null;
}

export function getCharacterName() {
    const context = SillyTavern.getContext();
    if (!context) return '未指定';
    const charId = getCharacterId();
    if (charId !== null && context.characters && context.characters[charId]) {
        return context.characters[charId].name || '未命名角色';
    }
    return '未指定';
}


export function getCharacterStableId() {
    const charName = getCharacterName();
    const sanitize = (id) => String(id).replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
    return sanitize(charName);
}


async function checkCollectionData(collectionId) {
    if (!collectionId) return false;
    const context = SillyTavern.getContext();
    if (!context) return false;
    try {
        const response = await fetch('/api/vector/list', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            body: JSON.stringify({ collectionId, source: 'webllm', embeddings: {} }),
        });
        if (!response.ok) return false;
        const result = await response.json();
        if (Array.isArray(result)) return result.length > 0;
        if (result && result.hashes) return result.hashes.length > 0;
        return false;
    } catch (error) {
        console.error(`[翰林院-典籍库] 检查集合 ${collectionId} 数据时出错:`, error);
        return false;
    }
}


function showMigrationNotification(oldId) {
    if (migrationNoticeShown.has(oldId)) return;

    const tutorialLink = 'https://docs.google.com/document/d/11E7HIFg59up0afv-lV0cAF5G3jzJXCkZK8cBCOMZ9zo/edit?usp=sharing';
    
    const htmlMessage = `
        <div class="toast-message-content">
            <p>当前使用的是旧版翰林院数据格式，为确保数据稳定，请手动迁移。</p>
            <p><strong>如不迁移，后续该角色的向量化操作可能会导致旧数据被清零。</strong></p>
            <p>（请挂魔法后打开此链接查看教程）</p>
        </div>
    `;

    const $toast = toastr.warning('', '翰林院数据迁移提醒', {
        timeOut: 0,
        extendedTimeOut: 0,
        closeButton: true,
        tapToDismiss: false,
        onclick: null,
        onShown: function() {
            const toastElement = $(this);

            const titleElement = toastElement.find('.toast-title');

            const messageContainer = $(htmlMessage);
            const buttonContainer = $('<div class="mt-2"></div>');
            
            const copyBtn = $('<button class="btn btn-info btn-sm mr-1">复制教程链接</button>');
            copyBtn.on('click', (e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(tutorialLink);
                toastr.success('链接已复制到剪贴板');
            });

            const approveBtn = $('<button class="btn btn-secondary btn-sm">我知道了</button>');
            approveBtn.on('click', (e) => {
                e.stopPropagation();
                toastr.remove($toast);
                migrationNoticeShown.add(oldId);
            });

            buttonContainer.append(copyBtn).append(approveBtn);

            if (titleElement.length) {
                titleElement.after(messageContainer, buttonContainer);
            } else {

                toastElement.append(messageContainer, buttonContainer);
            }
        },
        onCloseClick: function() {
            migrationNoticeShown.add(oldId);
        }
    });

    migrationNoticeShown.add(oldId);
}



export function getCollectionIdInfo() {
    const charId = getCharacterId();
    const chatId = getChatId();
    const charName = getCharacterName();

    const sanitize = (id) => String(id).replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '_');
    
    let oldCollectionId = null;
    if (charId !== null && chatId) {
        oldCollectionId = `char_${charId}_chat_${chatId}`;
    } else if (charId !== null) {
        oldCollectionId = `char_${charId}_global`;
    }
    const finalOldId = oldCollectionId ? sanitize(oldCollectionId) : null;

    let newCollectionId = null;
    if (charName !== '未指定' && charName !== '未命名角色' && chatId) {
        newCollectionId = `char_${charName}_chat_${chatId}`;
    } else if (charName !== '未指定' && charName !== '未命名角色') {
        newCollectionId = `char_${charName}_global`;
    }
    const finalNewId = newCollectionId ? sanitize(newCollectionId) : null;

    return { oldId: finalOldId, newId: finalNewId || finalOldId || 'default_collection' };
}

export async function getCollectionId() {
    const { oldId, newId } = getCollectionIdInfo();

    if (oldId === newId) {
        return newId || 'default_collection';
    }

    if (newId && await checkCollectionData(newId)) {
        return newId; 
    }

    if (oldId && await checkCollectionData(oldId)) {
        showMigrationNotification(oldId);
        return oldId;
    }

    return newId || 'default_collection';
}
