import { getContext } from '/scripts/extensions.js';
import { saveChat } from '/script.js';

function debounce(func, delay) {
    let timeout;
    return function(...args) {
        const context = this;
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(context, args), delay);
    };
}

export function getChatPiece() {
    const context = getContext();
    if (!context || !context.chat || !context.chat.length) {
        return { piece: null, deep: -1 };
    }

    const chat = context.chat;
    let index = chat.length - 1;

    while (index >= 0) {
        if (!chat[index].is_user) {
            return { piece: chat[index], deep: index };
        }
        index--;
    }

    if (chat.length > 0) {
        return { piece: chat[0], deep: 0 };
    }
    return { piece: null, deep: -1 };
}

export const saveChatDebounced = debounce(() => {
    saveChat();
}, 500);

export function escapeHTML(str) {
    if (!str) return '';
    return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
