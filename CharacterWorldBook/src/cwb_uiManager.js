import { SCRIPT_ID_PREFIX, CHAR_CARD_VIEWER_BUTTON_ID, CHAR_CARD_VIEWER_POPUP_ID, state } from './cwb_state.js';
import { logDebug, logError, showToastr, escapeHtml, parseCustomFormat, buildCustomFormat, isCwbEnabled } from './cwb_utils.js';
import { deleteLorebookEntries, getTargetWorldBook } from './cwb_lorebookManager.js';
import { manualUpdateLogic } from './cwb_core.js';
import { testCwbConnection, fetchCwbModels } from './cwb_apiService.js';
import { extensionName } from '../../utils/settings.js';
import { extension_settings } from '/scripts/extensions.js';
import { saveSettingsDebounced } from '/script.js';

const { jQuery: $, SillyTavern, TavernHelper } = window;

function createCharCardViewerPopupHtml(displayItems) {
    const pathToLabelMap = {
        'narrative_essence.core_traits.name': '特质名称',
        'narrative_essence.key_relationships.name': '关系人姓名',
    };
    const keyToLabelMap = {
        'name': '姓名',
        'archetype': '身份原型',
        'gender': '性别',
        'age': '年龄',
        'race': '种族',
        'current_status': '当前状态',

        'first_impression': '第一印象',
        'key_features': '显著特征',
        'attire': '衣着风格',
        'mannerisms': '习惯举止',
        'voice': '声音特征',

        'tags': '性格标签',
        'description': '性格详述',
        'motivation': '内在驱动',
        'values': '价值观',
        'inner_conflict': '内心挣扎',

        'interaction_style': '互动风格',
        'skills': '技能能力',
        'reputation': '他人声望',

        'core_traits': '核心特质',
        'verbal_patterns': '语言范式',
        'key_relationships': '关键关系',
        'definition': '特质定义',
        'evidence': '具体事例',
        'style_summary': '风格总结',
        'quotes': '代表性引言',
        'summary': '关系概述',
    };
    const getLabel = (key, path) => {
        const pathKey = path.replace(/\.\d+\./g, '.');
        if (pathToLabelMap[pathKey]) {
            return pathToLabelMap[pathKey];
        }
        return keyToLabelMap[key] || key.replace(/_/g, ' ');
    };

    const renderField = (label, path, value, isTextarea = false, isArray = false) => {
        const escapedLabel = escapeHtml(label);
        const escapedValue = escapeHtml(isArray ? value.join('\n') : value || '');

        const isLongContent = (value && String(value).length > 50) || (Array.isArray(value) && value.length > 1);
        const rows = isArray ? Math.max(3, value.length) : (isLongContent ? 4 : 2);

        const inputElement = `<textarea class="cwb-cyber-field__input" data-path="${path}" data-is-array="${isArray}" rows="${rows}">${escapedValue}</textarea>`;

        return `<div class="cwb-cyber-field">
                    <label class="cwb-cyber-field__label">${escapedLabel}</label>
                    ${inputElement}
                </div>`;
    };

    const renderCard = (title, data, pathPrefix) => {
        if (!data || typeof data !== 'object' || Object.keys(data).length === 0) return '';
        let cardHtml = `<div class="cwb-cyber-card"><h4 class="cwb-cyber-card__title">${escapeHtml(title)}</h4><div class="cwb-cyber-card__content">`;
        for (const [key, value] of Object.entries(data)) {
            const currentPath = pathPrefix ? `${pathPrefix}.${key}` : key;
            const label = getLabel(key, currentPath);
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                cardHtml += renderCard(label, value, currentPath); // Recursive call for nested objects
            } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
                cardHtml += `<div class="cwb-cyber-card cwb-cyber-card--nested"><h5 class="cwb-cyber-card__title">${escapeHtml(label)}</h5><div class="cwb-cyber-card__content">`;
                value.forEach((item, itemIndex) => {
                    cardHtml += `<div class="cwb-cyber-list-item">`;
                    for (const [itemKey, itemValue] of Object.entries(item)) {
                        const itemPath = `${currentPath}.${itemIndex}.${itemKey}`;
                        cardHtml += renderField(getLabel(itemKey, itemPath), itemPath, itemValue, false, Array.isArray(itemValue));
                    }
                    cardHtml += `</div>`;
                });
                cardHtml += `</div></div>`;
            } else {
                cardHtml += renderField(label, currentPath, value, false, Array.isArray(value));
            }
        }
        cardHtml += `</div></div>`;
        return cardHtml;
    };

    let html = `<div id="${CHAR_CARD_VIEWER_POPUP_ID}" class="cwb-cyber-popup">`;
    html += `<div class="cwb-cyber-popup__header">
                <h3 class="cwb-cyber-popup__title"><i class="fa-solid fa-book-atlas"></i> 角色数据核心</h3>
                <div class="cwb-cyber-popup__actions">
                    <button id="cwb-manual-update-btn" class="cwb-cyber-button" title="手动更新当前角色的描述"><i class="fa-solid fa-wand-magic-sparkles"></i> 更新</button>
                    <button id="cwb-viewer-refresh" class="cwb-cyber-button" title="从世界书重新加载所有角色卡"><i class="fa-solid fa-arrows-rotate"></i> 刷新</button>
                    <button id="cwb-viewer-delete-all" class="cwb-cyber-button cwb-cyber-button--danger" title="删除当前聊天中的所有角色卡和总览"><i class="fa-solid fa-trash-can"></i> 清除</button>
                    <button class="cwb-viewer-popup-close-button">&times;</button>
                </div>
             </div>`;

    if (!displayItems || displayItems.length === 0) {
        html += `<div class="cwb-cyber-popup__body cwb-cyber-popup__body--empty"><p>看什么？没更新角色条目就等着我给你显示出来条目吗？想关悬浮窗就点角色世界，功能设置关掉。</p></div></div>`;
        return html;
    }

    html += `<div class="cwb-cyber-popup__main-content">`;
    html += `<div class="cwb-cyber-tabs">`;
    displayItems.forEach((item, index) => {
        const itemName = item.isRoster ? '人物总览' : (item.parsed?.name || `未知实体 ${index + 1}`);
        const wrapperClass = index === 0 ? 'cwb-cyber-tab active' : 'cwb-cyber-tab';
        html += `<div class="${wrapperClass}" data-uid-wrapper="${item.uid}">
                    <button class="cwb-cyber-tab__button" data-char-uid="${item.uid}">${escapeHtml(itemName)}</button>
                    <button class="cwb-cyber-tab__delete" data-char-uid="${item.uid}" title="删除此条目"><i class="fa-solid fa-times"></i></button>
                 </div>`;
    });
    html += `</div>`;

    html += `<div class="cwb-cyber-popup__body">`;
    displayItems.forEach((item, index) => {
        html += `<div class="cwb-cyber-content-pane ${index === 0 ? 'active' : ''}" id="cwb-char-content-${item.uid}" data-uid="${item.uid}">`;
        if (item.isRoster) {
            html += `<div class="cwb-cyber-card">
                        <h4 class="cwb-cyber-card__title">人物总览 (只读)</h4>
                        <div class="cwb-cyber-card__content">
                            <textarea readonly class="cwb-cyber-field__input" style="height: 400px;">${escapeHtml(item.content)}</textarea>
                        </div>
                     </div>`;
        } else {
            const charData = item.parsed;
            if (charData) {
                const charName = charData.name || `角色 ${index + 1}`;
                if (charData.name) html += renderCard('姓名', { name: charData.name }, '');
                if (charData.core_identity) html += renderCard('核心认同', charData.core_identity, 'core_identity');
                if (charData.physical_imprint) html += renderCard('物理印记', charData.physical_imprint, 'physical_imprint');
                if (charData.psyche_profile) html += renderCard('心智侧写', charData.psyche_profile, 'psyche_profile');
                if (charData.social_matrix) html += renderCard('社交矩阵', charData.social_matrix, 'social_matrix');
                if (charData.narrative_essence) html += renderCard('叙事精粹', charData.narrative_essence, 'narrative_essence');
                
                html += `<div class="cwb-cyber-card cwb-insertion-settings-card">
                            <h4 class="cwb-cyber-card__title">注入设置</h4>
                            <div class="cwb-cyber-card__content cwb-insertion-settings-content">
                                <div class="cwb-cyber-field">
                                    <label class="cwb-cyber-field__label" for="cwb-insertion-position-${item.uid}">注入位置</label>
                                    <select id="cwb-insertion-position-${item.uid}" class="cwb-cyber-field__input cwb-insertion-position" data-uid="${item.uid}">
                                        <option value="before_char" ${item.insertionPosition === 'before_char' ? 'selected' : ''}>角色定义之前</option>
                                        <option value="after_char" ${item.insertionPosition === 'after_char' ? 'selected' : ''}>角色定义之后</option>
                                        <option value="before_an" ${item.insertionPosition === 'before_an' ? 'selected' : ''}>作者注释之前</option>
                                        <option value="after_an" ${item.insertionPosition === 'after_an' ? 'selected' : ''}>作者注释之后</option>
                                        <option value="at_depth" ${item.insertionPosition === 'at_depth' ? 'selected' : ''}>@D 注入指定深度</option>
                                    </select>
                                </div>
                                <div class="cwb-cyber-field cwb-insertion-depth-container" style="${item.insertionPosition === 'at_depth' ? '' : 'display: none;'}">
                                    <label class="cwb-cyber-field__label" for="cwb-insertion-depth-${item.uid}">注入深度</label>
                                    <input id="cwb-insertion-depth-${item.uid}" type="number" class="cwb-cyber-field__input cwb-insertion-depth" value="${item.insertionDepth}" min="0" max="9999">
                                </div>
                                <div class="cwb-cyber-field">
                                    <label class="cwb-cyber-field__label" for="cwb-insertion-order-${item.uid}">注入顺序</label>
                                    <input id="cwb-insertion-order-${item.uid}" type="number" class="cwb-cyber-field__input cwb-insertion-order" value="${item.insertionOrder}" min="0">
                                </div>
                            </div>
                         </div>`;

                html += `<div class="cwb-cyber-content-pane__footer">
                            <button class="cwb-cyber-button cwb-cyber-button--primary cwb-save-button" data-uid="${item.uid}">
                                <i class="fa-solid fa-save"></i> 保存对 ${escapeHtml(charName)} 的修改
                            </button>
                         </div>`;
            }
        }
        html += `</div>`;
    });
    html += `</div></div></div>`;
    return html;
}

function bindCharCardViewerPopupEvents($popup) {
    $popup.on('change', '.cwb-insertion-position', function() {
        const $this = $(this);
        const $depthContainer = $this.closest('.cwb-insertion-settings-content').find('.cwb-insertion-depth-container');
        if ($this.val() === 'at_depth') {
            $depthContainer.show();
        } else {
            $depthContainer.hide();
        }
    });

    $popup.on('click', '.cwb-viewer-popup-close-button', closeCharCardViewerPopup);
    $popup.find('#cwb-viewer-refresh').on('click', () => {
        showToastr('info', '正在刷新角色数据...');
        showCharCardViewerPopup();
    });

    $popup.find('#cwb-manual-update-btn').on('click', async function() {
        const $button = $(this);
        $button.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 更新中...');
        await manualUpdateLogic();
        showToastr('info', '更新完成，正在刷新查看器...');
        showCharCardViewerPopup();
    });

    $popup.find('.cwb-cyber-tab__button').on('click', function () {
        const $this = $(this);
        const targetUid = $this.data('char-uid');
        $popup.find('.cwb-cyber-tab').removeClass('active');
        $this.closest('.cwb-cyber-tab').addClass('active');
        $popup.find('.cwb-cyber-content-pane').removeClass('active');
        $popup.find(`#cwb-char-content-${targetUid}`).addClass('active');
    });

    $popup.find('.cwb-cyber-tab__delete').on('click', async function(e) {
        e.stopPropagation();
        if (confirm('您确定要删除这个角色条目吗？此操作不可撤销。')) {
            const uidToDelete = $(this).data('char-uid');
            await deleteLorebookEntries([uidToDelete]);
            const $wrapper = $(this).closest('.cwb-cyber-tab');
            const $pane = $popup.find(`#cwb-char-content-${uidToDelete}`);
            const wasActive = $wrapper.hasClass('active');
            $wrapper.remove();
            $pane.remove();
            if (wasActive && $popup.find('.cwb-cyber-tab').length > 0) {
                $popup.find('.cwb-cyber-tab').first().find('.cwb-cyber-tab__button').trigger('click');
            } else if ($popup.find('.cwb-cyber-tab').length === 0) {
                showCharCardViewerPopup();
            }
        }
    });

    $popup.find('#cwb-viewer-delete-all').on('click', async function() {
        if (confirm('您确定要清除当前聊天中的所有角色卡和总览吗？此操作将删除所有相关条目，且不可撤销。')) {
            const allUids = $popup.find('.cwb-cyber-tab__button').map(function() {
                return $(this).data('char-uid');
            }).get();
            if (allUids.length > 0) {
                await deleteLorebookEntries(allUids);
            }
            showCharCardViewerPopup();
        }
    });

    $popup.find('.cwb-save-button').on('click', async function () {
        const $button = $(this);
        const targetUid = $button.data('uid');
        $button.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 保存中...');
        try {
            const book = await getTargetWorldBook();
            if (!book) throw new Error('未找到目标世界书。');
            const $activePane = $popup.find(`#cwb-char-content-${targetUid}`);
            const collectedData = {};
            const setNestedValue = (obj, path, value) => {
                const keys = path.split('.');
                let current = obj;
                keys.forEach((key, index) => {
                    if (index === keys.length - 1) {
                        current[key] = value === '' ? null : value;
                    } else {
                        const nextKeyIsNumber = /^\d+$/.test(keys[index + 1]);
                        if (!current[key]) {
                            current[key] = nextKeyIsNumber ? [] : {};
                        }
                        current = current[key];
                    }
                });
            };
            $activePane.find('.cwb-cyber-field__input').each(function () {
                const $field = $(this);
                const path = $field.data('path');
                let value = $field.val();
                if ($field.data('is-array')) {
                    value = value.split('\n').map(l => l.trim()).filter(Boolean);
                }
                if(path){
                   setNestedValue(collectedData, path, value);
                }
            });
            const finalContentToSave = buildCustomFormat(collectedData);
            const allEntries = await TavernHelper.getLorebookEntries(book);
            const entryToUpdate = allEntries.find(e => e.uid === targetUid);
            if (!entryToUpdate) throw new Error('无法在世界书中找到原始条目。');

            const insertionPosition = $activePane.find('.cwb-insertion-position').val();
            const insertionDepth = parseInt($activePane.find('.cwb-insertion-depth').val(), 10);
            const insertionOrder = parseInt($activePane.find('.cwb-insertion-order').val(), 10);

            logDebug(`[DEBUG] 界面收集值 UID:${targetUid}`, {
                insertionPosition: insertionPosition,
                insertionDepth: insertionDepth,
                insertionOrder: insertionOrder
            });

            const positionMap = {
                'before_char': 'before_character_definition',
                'after_char': 'after_character_definition', 
                'before_an': 'before_author_note',
                'after_an': 'after_author_note',
                'at_depth': 'at_depth_as_system'
            };

            const finalEntryData = { ...entryToUpdate };

            finalEntryData.content = finalContentToSave;
            finalEntryData.uid = targetUid;
            
            const newPosition = positionMap[insertionPosition];
            finalEntryData.position = newPosition || 'before_character_definition';
            if (insertionPosition === 'at_depth') {
                finalEntryData.depth = isNaN(insertionDepth) ? 0 : insertionDepth;
            } else {
                finalEntryData.depth = null;
            }
            
            finalEntryData.order = isNaN(insertionOrder) ? 7001 : insertionOrder;

            logDebug(`[DEBUG] 最终保存数据 UID:${targetUid}`, {
                position: finalEntryData.position,
                depth: finalEntryData.depth,
                order: finalEntryData.order,
                hasDepthField: 'depth' in finalEntryData
            });

            await TavernHelper.setLorebookEntries(book, [finalEntryData]);
            showToastr('success', '角色卡已成功保存！');
        } catch (error) {
            logError('保存角色卡失败:', error);
            showToastr('error', `保存失败: ${error.message}`);
        } finally {
            $button.prop('disabled', false).text(`保存修改`);
        }
    });
}

function closeCharCardViewerPopup() {
    $(`#${CHAR_CARD_VIEWER_POPUP_ID}`).remove();
}

export async function showCharCardViewerPopup() {
    if (!isCwbEnabled()) return; 
    closeCharCardViewerPopup();
    try {
        const book = await getTargetWorldBook();
        if (!book) {
            showToastr('warning', '当前角色未设置主世界书或自定义世界书。');
            $('body').append(createCharCardViewerPopupHtml([]));
            bindCharCardViewerPopupEvents($(`#${CHAR_CARD_VIEWER_POPUP_ID}`));
            return;
        }
        const allEntries = await TavernHelper.getLorebookEntries(book);
        let currentChatId = state.currentChatFileIdentifier;

        if (!currentChatId || currentChatId.startsWith('unknown_chat')) {
            logError(`Invalid chat identifier "${currentChatId}" for viewer.`);
            $('body').append(createCharCardViewerPopupHtml([]));
            bindCharCardViewerPopupEvents($(`#${CHAR_CARD_VIEWER_POPUP_ID}`));
            return;
        }
        
        const cleanChatId = currentChatId.replace(/ imported/g, '');
        let displayItems = [];

        let relevantEntries;
        if (state.worldbookTarget === 'custom' && state.customWorldBook) {
            relevantEntries = allEntries.filter(entry => {
                if (!entry.enabled || !Array.isArray(entry.keys)) return false;
                if (entry.keys.includes('Amily2角色总集') || entry.keys.includes('角色总览')) return true;
                if (entry.content) {
                    try {
                        const parsed = parseCustomFormat(entry.content);
                        return parsed && Object.keys(parsed).length > 0;
                    } catch (e) {
                        return false;
                    }
                }
                
                return false;
            });
        } else {
            relevantEntries = allEntries.filter(entry => 
                entry.enabled &&
                Array.isArray(entry.keys) &&
                entry.keys.includes(cleanChatId)
            );
        }

        const rosterEntries = relevantEntries.filter(entry => 
            entry.keys.includes('Amily2角色总集') && entry.keys.includes('角色总览')
        );

        rosterEntries.forEach((entry, index) => {
            displayItems.push({ 
                uid: entry.uid, 
                isRoster: true, 
                comment: entry.comment, 
                content: entry.content,
                rosterIndex: index 
            });
        });

        const characterEntries = relevantEntries
            .filter(entry => !entry.keys.includes('Amily2角色总集'))
            .map(entry => {
                logDebug(`[DEBUG] 原始条目数据 UID:${entry.uid}`, {
                    position: entry.position,
                    depth: entry.depth,
                    order: entry.order,
                    comment: entry.comment
                });

                const positionStringMap = {
                    0: 'before_char',
                    1: 'after_char',
                    2: 'before_an', 
                    3: 'after_an',
                    4: 'at_depth',
                    'before_character_definition': 'before_char',
                    'after_character_definition': 'after_char',
                    'before_author_note': 'before_an',
                    'after_author_note': 'after_an',
                    'at_depth_as_system': 'at_depth'
                };

                const position = entry.position;
                const mappedPosition = positionStringMap[position] || 'at_depth';
                const finalDepth = (position === 4 || position === 'at_depth_as_system') ? (entry.depth ?? 0) : 0;
                logDebug(`[DEBUG] 映射结果 UID:${entry.uid}`, {
                    originalPosition: position,
                    mappedPosition: mappedPosition,
                    finalDepth: finalDepth
                });

                return {
                    uid: entry.uid,
                    isRoster: false,
                    comment: entry.comment,
                    content: entry.content,
                    parsed: parseCustomFormat(entry.content),
                    insertionPosition: mappedPosition,
                    insertionDepth: finalDepth,
                    insertionOrder: entry.order ?? 7001,
                };
            })
            .filter(c => c.parsed && Object.keys(c.parsed).length > 0);
        
        displayItems = displayItems.concat(characterEntries);

        const popupHtml = createCharCardViewerPopupHtml(displayItems);
        $('body').append(popupHtml);
        const $popup = $(`#${CHAR_CARD_VIEWER_POPUP_ID}`);
        bindCharCardViewerPopupEvents($popup);
    } catch (error) {
        logError('无法显示角色卡查看器:', error);
        showToastr('error', '加载角色卡数据时出错。');
    }
}

function toggleCharCardViewerPopup() {
    if ($(`#${CHAR_CARD_VIEWER_POPUP_ID}`).length > 0) {
        closeCharCardViewerPopup();
    } else {
        showCharCardViewerPopup();
    }
}

function keepButtonInBounds($element, savePosition = false) {
    if (!$element || !$element.length) return;
    const windowWidth = $(window).width();
    const windowHeight = $(window).height();
    const buttonWidth = $element.outerWidth();
    const buttonHeight = $element.outerHeight();
    let currentPos = $element.offset();
    let newTop = Math.max(0, Math.min(currentPos.top, windowHeight - buttonHeight));
    let newLeft = Math.max(0, Math.min(currentPos.left, windowWidth - buttonWidth));
    $element.css({ top: `${newTop}px`, left: `${newLeft}px` });
    if (savePosition) {
        localStorage.setItem(state.STORAGE_KEY_VIEWER_BUTTON_POS, JSON.stringify({ top: $element.css('top'), left: $element.css('left') }));
    }
}

function makeButtonDraggable($button) {
    let isDragging = false, wasDragged = false, offset = { x: 0, y: 0 }, startPos = { x: 0, y: 0 };
    const DRAG_THRESHOLD = 5; // 5 pixels threshold

    const getCoords = (e) => e.touches && e.touches.length ? e.touches[0] : e;

    const dragStart = function (e) {
        if (e.type === 'touchstart') e.preventDefault();
        isDragging = true;
        wasDragged = false;
        const coords = getCoords(e);
        startPos.x = coords.clientX;
        startPos.y = coords.clientY;
        offset.x = coords.clientX - $button.offset().left;
        offset.y = coords.clientY - $button.offset().top;
        $button.css('cursor', 'grabbing');
        $('body').css({ 'user-select': 'none', '-webkit-user-select': 'none' });
    };

    const dragMove = function (e) {
        if (!isDragging) return;
        const coords = getCoords(e);
        const dx = coords.clientX - startPos.x;
        const dy = coords.clientY - startPos.y;

        if (!wasDragged && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
            wasDragged = true;
        }

        if (wasDragged) {
            if (e.type === 'touchmove') e.preventDefault();
            let newX = coords.clientX - offset.x;
            let newY = coords.clientY - offset.y;
            newX = Math.max(0, Math.min(newX, window.innerWidth - $button.outerWidth()));
            newY = Math.max(0, Math.min(newY, window.innerHeight - $button.outerHeight()));
            $button.css({ top: newY + 'px', left: newX + 'px', right: '', bottom: '' });
        }
    };

    const dragEnd = function (e) {
        if (!isDragging) return;
        isDragging = false;
        $button.css('cursor', 'grab');
        $('body').css({ 'user-select': 'auto', '-webkit-user-select': 'auto' });
        if (wasDragged) {
            keepButtonInBounds($button, true);
        } else if (e.type === 'touchend') {
            e.preventDefault();
            toggleCharCardViewerPopup();
        }
    };

    $button.on('mousedown', dragStart);
    $(document).on('mousemove.cwbViewer', dragMove).on('mouseup.cwbViewer', dragEnd);
    $button.on('touchstart', dragStart);
    $(document).on('touchmove.cwbViewer', dragMove).on('touchend.cwbViewer', dragEnd);

    $button.on('click', function (e) {
        if (wasDragged) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        toggleCharCardViewerPopup();
    });
}

export function initializeCharCardViewer() {
    const $existingButton = $(`#${CHAR_CARD_VIEWER_BUTTON_ID}`);
    
    if ($existingButton.length > 0) {
        console.log('[CWB] Char card viewer button already exists');
        setTimeout(() => {
            const shouldShow = isCwbEnabled() && state.viewerEnabled;
            $existingButton.toggle(shouldShow);
            console.log(`[CWB] Force updated existing button visibility: ${shouldShow}`);
        }, 100);
        return;
    }
    
    const buttonHtml = `<div id="${CHAR_CARD_VIEWER_BUTTON_ID}" title="查看角色世界书" class="fa-solid fa-book-open"></div>`;
    $('body').append(buttonHtml);
    const $viewerButton = $(`#${CHAR_CARD_VIEWER_BUTTON_ID}`);
    makeButtonDraggable($viewerButton);
    
    const savedPosition = JSON.parse(localStorage.getItem(state.STORAGE_KEY_VIEWER_BUTTON_POS) || 'null');
    if (savedPosition) {
        $viewerButton.css({ top: savedPosition.top, left: savedPosition.left });
    } else {
        $viewerButton.css({ top: '120px', right: '10px', left: 'auto' });
    }

    setTimeout(() => {
        const shouldShow = isCwbEnabled() && state.viewerEnabled;
        $viewerButton.toggle(shouldShow);
        console.log(`[CWB] New button created with visibility: ${shouldShow}`);
    }, 100);
    
    console.log('[CWB] Char card viewer button initialized');
    
    let resizeTimeout;
    $(window).on('resize.cwbViewer', function () {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(() => keepButtonInBounds($(`#${CHAR_CARD_VIEWER_BUTTON_ID}`), true), 150);
    });
}

export function updateViewerButtonVisibility() {
    const $button = $(`#${CHAR_CARD_VIEWER_BUTTON_ID}`);
    const shouldShow = isCwbEnabled() && state.viewerEnabled;
    
    console.log(`[CWB] Updating viewer button visibility: ${shouldShow} (master: ${isCwbEnabled()}, viewer: ${state.viewerEnabled})`);
    
    if ($button.length > 0) {
        $button.toggle(shouldShow);
        console.log(`[CWB] Viewer button visibility set to: ${shouldShow}`);
    } else {
        console.log('[CWB] Viewer button not found, will initialize when DOM is ready');
        // Try to initialize if button doesn't exist yet
        setTimeout(() => {
            initializeCharCardViewer();
        }, 500);
    }
    
    logDebug('悬浮窗按钮显示状态更新:', {
        masterEnabled: isCwbEnabled(),
        viewerEnabled: state.viewerEnabled,
        shouldShow: shouldShow
    });
}

export function bindCwbApiEvents() {
    console.log('[CWB] Binding API events');
    
    $('#cwb-api-url').off('input').on('input', function() {
        const value = $(this).val();
        extension_settings[extensionName].cwb_api_url = value;
        saveSettingsDebounced();
    });

    $('#cwb-api-key').off('input').on('input', function() {
        const value = $(this).val();
        extension_settings[extensionName].cwb_api_key = value;
        saveSettingsDebounced();
    });

    $('#cwb-model').off('input').on('input', function() {
        const value = $(this).val();
        extension_settings[extensionName].cwb_model = value;
        saveSettingsDebounced();
    });

    $('#cwb-temperature').off('input').on('input', function() {
        const value = parseFloat($(this).val());
        $('#cwb-temperature-value').text(value);
        extension_settings[extensionName].cwb_temperature = value;
        saveSettingsDebounced();
    });

    $('#cwb-max-tokens').off('input').on('input', function() {
        const value = parseInt($(this).val());
        $('#cwb-max-tokens-value').text(value);
        extension_settings[extensionName].cwb_max_tokens = value;
        saveSettingsDebounced();
    });

    $('#cwb-test-connection').off('click').on('click', async function() {
        const $button = $(this);
        $button.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 测试中...');
        
        try {
            await testCwbConnection();
        } catch (error) {
            console.error('[CWB] 测试连接失败:', error);
        } finally {
            $button.prop('disabled', false).html('<i class="fas fa-plug"></i> 测试连接');
        }
    });

    $('#cwb-fetch-models').off('click').on('click', async function() {
        const $button = $(this);
        $button.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i> 获取中...');
        
        try {
            const models = await fetchCwbModels();
            const $modelSelect = $('#cwb-model');
            $modelSelect.empty();
            
            if (models && models.length > 0) {
                models.forEach(model => {
                    $modelSelect.append(new Option(model.name, model.id));
                });
                showToastr('success', `已获取到 ${models.length} 个模型`);
            } else {
                $modelSelect.append(new Option('无可用模型', ''));
                showToastr('warning', '未获取到可用模型');
            }
        } catch (error) {
            console.error('[CWB] 获取模型失败:', error);
            $('#cwb-model').empty().append(new Option('获取失败', ''));
        } finally {
            $button.prop('disabled', false).html('<i class="fas fa-download"></i> 获取模型');
        }
    });
}
