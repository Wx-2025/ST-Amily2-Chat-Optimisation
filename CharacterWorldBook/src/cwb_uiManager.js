    import { SCRIPT_ID_PREFIX, CHAR_CARD_VIEWER_BUTTON_ID, CHAR_CARD_VIEWER_POPUP_ID, state } from './cwb_state.js';
    import { logDebug, logError, showToastr, parseCustomFormat, buildCustomFormat, isCwbEnabled } from './cwb_utils.js';
    import { deleteLorebookEntries, getTargetWorldBook } from './cwb_lorebookManager.js';
    import { manualUpdateLogic } from './cwb_core.js';
    import { testCwbConnection, fetchCwbModels } from './cwb_apiService.js';
    import { extensionName } from '../../utils/settings.js';
    import { extension_settings } from '/scripts/extensions.js';
    import { saveSettingsDebounced } from '/script.js';
    import { amilyHelper } from '../../core/tavern-helper/main.js';
    import { configManager } from '../../utils/config/ConfigManager.js';
    import { watchProfileSliderGuard } from '../../ui/profile-slider-guard.js';

    import { t, cwbLabel, setCwbText, setCwbHtml, initializeCwbI18n, escapeCwbHtml as escapeHtml } from './cwb_i18n.js';

    const { jQuery: $, SillyTavern } = window;

    function createCharCardViewerPopupHtml(displayItems) {
        const pathToLabelMap = {
            'narrative_essence.core_traits.name': 'characterWorldUi.field.traitName',
            'narrative_essence.key_relationships.name': 'characterWorldUi.field.relationName',
            'NE.trait.name': 'characterWorldUi.field.traitName',
            'NE.rel.name': 'characterWorldUi.field.relationName',
        };
        const keyToLabelMap = {
            'name': 'characterWorldUi.field.name',
            // Old keys
            'archetype': 'characterWorldUi.field.archetype',
            'gender': 'characterWorldUi.field.gender',
            'age': 'characterWorldUi.field.age',
            'race': 'characterWorldUi.field.race',
            'current_status': 'characterWorldUi.field.status',
            'first_impression': 'characterWorldUi.field.first',
            'key_features': 'characterWorldUi.field.features',
            'attire': 'characterWorldUi.field.attire',
            'mannerisms': 'characterWorldUi.field.mannerisms',
            'voice': 'characterWorldUi.field.voice',
            'tags': 'characterWorldUi.field.tags',
            'description': 'characterWorldUi.field.description',
            'motivation': 'characterWorldUi.field.motivation',
            'values': 'characterWorldUi.field.values',
            'inner_conflict': 'characterWorldUi.field.conflict',
            'interaction_style': 'characterWorldUi.field.interaction',
            'skills': 'characterWorldUi.field.skills',
            'reputation': 'characterWorldUi.field.reputation',
            'core_traits': 'characterWorldUi.field.traits',
            'verbal_patterns': 'characterWorldUi.field.verbal',
            'key_relationships': 'characterWorldUi.field.relationships',
            'definition': 'characterWorldUi.field.definition',
            'evidence': 'characterWorldUi.field.evidence',
            'style_summary': 'characterWorldUi.field.styleSummary',
            'quotes': 'characterWorldUi.field.quotes',
            'summary': 'characterWorldUi.field.summary',

            // New short keys
            'CI': 'characterWorldUi.field.identity',
            'PI': 'characterWorldUi.field.physical',
            'PP': 'characterWorldUi.field.psyche',
            'SM': 'characterWorldUi.field.social',
            'NE': 'characterWorldUi.field.narrative',
            
            'arch': 'characterWorldUi.field.archetype',
            'gen': 'characterWorldUi.field.gender',
            // age is same
            // race is same
            'status': 'characterWorldUi.field.status',

            'first': 'characterWorldUi.field.first',
            'feat': 'characterWorldUi.field.features',
            // attire is same
            'manner': 'characterWorldUi.field.mannerisms',
            // voice is same

            // tags is same
            'desc': 'characterWorldUi.field.description',
            'mot': 'characterWorldUi.field.motivation',
            'val': 'characterWorldUi.field.values',
            'conf': 'characterWorldUi.field.conflict',

            'style': 'characterWorldUi.field.style', // Shared by SM.style and NE.verb.style
            'skill': 'characterWorldUi.field.skills',
            'rep': 'characterWorldUi.field.reputation',

            'trait': 'characterWorldUi.field.traits',
            'verb': 'characterWorldUi.field.verbal',
            'rel': 'characterWorldUi.field.relationships',

            'def': 'characterWorldUi.field.definition',
            'evid': 'characterWorldUi.field.evidence',
            'quote': 'characterWorldUi.field.quotes',
            'sum': 'characterWorldUi.field.summary',
        };
        const getLabel = (key, path) => {
            const pathKey = path.replace(/\.\d+\./g, '.');
            if (Object.hasOwn(pathToLabelMap, pathKey)) {
                return cwbLabel(pathToLabelMap[pathKey]);
            }
            return Object.hasOwn(keyToLabelMap, key) ? cwbLabel(keyToLabelMap[key]) : escapeHtml(key.replace(/_/g, ' '));
        };

        const renderField = (label, path, value, isTextarea = false, isArray = false) => {
            const escapedLabel = label;
            const escapedValue = escapeHtml(isArray ? value.join('\n') : value || '');

            const isLongContent = (value && String(value).length > 50) || (Array.isArray(value) && value.length > 1);
            const rows = isArray ? Math.max(3, value.length) : (isLongContent ? 4 : 2);

            const inputElement = `<textarea class="cwb-cyber-field__input" data-path="${escapeHtml(path)}" data-is-array="${isArray}" rows="${rows}">${escapedValue}</textarea>`;

            return `<div class="cwb-cyber-field">
                        <label class="cwb-cyber-field__label">${escapedLabel}</label>
                        ${inputElement}
                    </div>`;
        };

        const renderCard = (title, data, pathPrefix) => {
            if (!data || typeof data !== 'object' || Object.keys(data).length === 0) return '';
            let cardHtml = `<div class="cwb-cyber-card"><h4 class="cwb-cyber-card__title">${title}</h4><div class="cwb-cyber-card__content">`;
            for (const [key, value] of Object.entries(data)) {
                const currentPath = pathPrefix ? `${pathPrefix}.${key}` : key;
                const label = getLabel(key, currentPath);
                if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                    cardHtml += renderCard(label, value, currentPath); // Recursive call for nested objects
                } else if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object') {
                    cardHtml += `<div class="cwb-cyber-card cwb-cyber-card--nested"><h5 class="cwb-cyber-card__title">${label}</h5><div class="cwb-cyber-card__content">`;
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
                    <h3 class="cwb-cyber-popup__title"><i class="fa-solid fa-book-atlas"></i> ${cwbLabel('characterWorldUi.viewer.title')}</h3>
                    <div class="cwb-cyber-popup__actions">
                        <button id="cwb-manual-update-btn" class="cwb-cyber-button" title="${escapeHtml(t('characterWorldUi.viewer.updateTitle'))}" data-cwb-i18n-title="characterWorldUi.viewer.updateTitle"><i class="fa-solid fa-wand-magic-sparkles"></i> ${cwbLabel('characterWorldUi.viewer.update')}</button>
                        <button id="cwb-viewer-refresh" class="cwb-cyber-button" title="${escapeHtml(t('characterWorldUi.viewer.refreshTitle'))}" data-cwb-i18n-title="characterWorldUi.viewer.refreshTitle"><i class="fa-solid fa-arrows-rotate"></i> ${cwbLabel('characterWorldUi.refresh')}</button>
                        <button id="cwb-viewer-delete-all" class="cwb-cyber-button cwb-cyber-button--danger" title="${escapeHtml(t('characterWorldUi.viewer.clearTitle'))}" data-cwb-i18n-title="characterWorldUi.viewer.clearTitle"><i class="fa-solid fa-trash-can"></i> ${cwbLabel('characterWorldUi.viewer.clear')}</button>
                        <button class="cwb-viewer-popup-close-button">&times;</button>
                    </div>
                </div>`;

        if (!displayItems || displayItems.length === 0) {
            html += `<div class="cwb-cyber-popup__body cwb-cyber-popup__body--empty"><p>${cwbLabel('characterWorldUi.viewer.empty')}</p></div></div>`;
            return html;
        }

        html += `<div class="cwb-cyber-popup__main-content">`;
        html += `<div class="cwb-cyber-tabs">`;
        displayItems.forEach((item, index) => {
            const itemName = item.isRoster ? cwbLabel('characterWorldUi.viewer.roster') : (item.parsed?.name ? escapeHtml(item.parsed.name) : cwbLabel('characterWorldUi.viewer.unknown', { index: index + 1 }));
            const wrapperClass = index === 0 ? 'cwb-cyber-tab active' : 'cwb-cyber-tab';
            html += `<div class="${wrapperClass}" data-uid-wrapper="${escapeHtml(item.uid)}">
                        <button class="cwb-cyber-tab__button" data-char-uid="${escapeHtml(item.uid)}">${itemName}</button>
                        <button class="cwb-cyber-tab__delete" data-char-uid="${escapeHtml(item.uid)}" title="${escapeHtml(t('characterWorldUi.viewer.deleteTitle'))}" data-cwb-i18n-title="characterWorldUi.viewer.deleteTitle"><i class="fa-solid fa-times"></i></button>
                    </div>`;
        });
        html += `</div>`;

        html += `<div class="cwb-cyber-popup__body">`;
        displayItems.forEach((item, index) => {
            html += `<div class="cwb-cyber-content-pane ${index === 0 ? 'active' : ''}" id="cwb-char-content-${escapeHtml(item.uid)}" data-uid="${escapeHtml(item.uid)}">`;
            if (item.isRoster) {
                html += `<div class="cwb-cyber-card">
                            <h4 class="cwb-cyber-card__title">${cwbLabel('characterWorldUi.viewer.rosterReadonly')}</h4>
                            <div class="cwb-cyber-card__content">
                                <textarea readonly class="cwb-cyber-field__input" style="height: 400px;">${escapeHtml(item.content)}</textarea>
                            </div>
                        </div>`;
            } else {
                const charData = item.parsed;
                if (charData) {
                    const charName = charData.name ? escapeHtml(charData.name) : cwbLabel('characterWorldUi.viewer.character', { index: index + 1 });
                    if (charData.name) html += renderCard(cwbLabel('characterWorldUi.field.name'), { name: charData.name }, '');
                    
                    // Support both old and new formats
                    if (charData.core_identity) html += renderCard(cwbLabel('characterWorldUi.field.identity'), charData.core_identity, 'core_identity');
                    if (charData.CI) html += renderCard(cwbLabel('characterWorldUi.field.identity'), charData.CI, 'CI');

                    if (charData.physical_imprint) html += renderCard(cwbLabel('characterWorldUi.field.physical'), charData.physical_imprint, 'physical_imprint');
                    if (charData.PI) html += renderCard(cwbLabel('characterWorldUi.field.physical'), charData.PI, 'PI');

                    if (charData.psyche_profile) html += renderCard(cwbLabel('characterWorldUi.field.psyche'), charData.psyche_profile, 'psyche_profile');
                    if (charData.PP) html += renderCard(cwbLabel('characterWorldUi.field.psyche'), charData.PP, 'PP');

                    if (charData.social_matrix) html += renderCard(cwbLabel('characterWorldUi.field.social'), charData.social_matrix, 'social_matrix');
                    if (charData.SM) html += renderCard(cwbLabel('characterWorldUi.field.social'), charData.SM, 'SM');

                    if (charData.narrative_essence) html += renderCard(cwbLabel('characterWorldUi.field.narrative'), charData.narrative_essence, 'narrative_essence');
                    if (charData.NE) html += renderCard(cwbLabel('characterWorldUi.field.narrative'), charData.NE, 'NE');
                    
                    html += `<div class="cwb-cyber-card cwb-insertion-settings-card">
                                <h4 class="cwb-cyber-card__title">${cwbLabel('characterWorldUi.viewer.insertion')}</h4>
                                <div class="cwb-cyber-card__content cwb-insertion-settings-content">
                                    <div class="cwb-cyber-field">
                                        <label class="cwb-cyber-field__label" for="cwb-insertion-position-${escapeHtml(item.uid)}">${cwbLabel('characterWorldUi.viewer.position')}</label>
                                        <select id="cwb-insertion-position-${escapeHtml(item.uid)}" class="cwb-cyber-field__input cwb-insertion-position" data-uid="${escapeHtml(item.uid)}">
                                            <option value="before_char" ${item.insertionPosition === 'before_char' ? 'selected' : ''} data-cwb-i18n="characterWorldUi.viewer.beforeChar">${escapeHtml(t('characterWorldUi.viewer.beforeChar'))}</option>
                                            <option value="after_char" ${item.insertionPosition === 'after_char' ? 'selected' : ''} data-cwb-i18n="characterWorldUi.viewer.afterChar">${escapeHtml(t('characterWorldUi.viewer.afterChar'))}</option>
                                            <option value="before_an" ${item.insertionPosition === 'before_an' ? 'selected' : ''} data-cwb-i18n="characterWorldUi.viewer.beforeNote">${escapeHtml(t('characterWorldUi.viewer.beforeNote'))}</option>
                                            <option value="after_an" ${item.insertionPosition === 'after_an' ? 'selected' : ''} data-cwb-i18n="characterWorldUi.viewer.afterNote">${escapeHtml(t('characterWorldUi.viewer.afterNote'))}</option>
                                            <option value="at_depth" ${item.insertionPosition === 'at_depth' ? 'selected' : ''} data-cwb-i18n="characterWorldUi.viewer.atDepth">${escapeHtml(t('characterWorldUi.viewer.atDepth'))}</option>
                                        </select>
                                    </div>
                                    <div class="cwb-cyber-field cwb-insertion-depth-container" style="${item.insertionPosition === 'at_depth' ? '' : 'display: none;'}">
                                        <label class="cwb-cyber-field__label" for="cwb-insertion-depth-${escapeHtml(item.uid)}">${cwbLabel('characterWorldUi.viewer.depth')}</label>
                                        <input id="cwb-insertion-depth-${escapeHtml(item.uid)}" type="number" class="cwb-cyber-field__input cwb-insertion-depth" value="${escapeHtml(item.insertionDepth)}" min="0" max="9999">
                                    </div>
                                    <div class="cwb-cyber-field">
                                        <label class="cwb-cyber-field__label" for="cwb-insertion-order-${escapeHtml(item.uid)}">${cwbLabel('characterWorldUi.viewer.order')}</label>
                                        <input id="cwb-insertion-order-${escapeHtml(item.uid)}" type="number" class="cwb-cyber-field__input cwb-insertion-order" value="${escapeHtml(item.insertionOrder)}" min="0">
                                    </div>
                                </div>
                            </div>`;

                    html += `<div class="cwb-cyber-content-pane__footer">
                                <button class="cwb-cyber-button cwb-cyber-button--primary cwb-save-button" data-uid="${escapeHtml(item.uid)}">
                                    <i class="fa-solid fa-save"></i> ${cwbLabel('characterWorldUi.viewer.saveBefore')}${charName}${cwbLabel('characterWorldUi.viewer.saveAfter')}
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
        initializeCwbI18n($popup, 'viewer');
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
            showToastr('info', t('characterWorldUi.viewer.refreshing'));
            showCharCardViewerPopup();
        });

        $popup.find('#cwb-manual-update-btn').on('click', async function() {
            const $button = $(this);
            setCwbHtml($button.prop('disabled', true), '<i class="fas fa-spinner fa-spin"></i> ' + cwbLabel('characterWorldUi.updating'));
            await manualUpdateLogic();
            showToastr('info', t('characterWorldUi.viewer.updated'));
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
            if (confirm(t('characterWorldUi.viewer.deleteConfirm'))) {
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
            if (confirm(t('characterWorldUi.viewer.clearConfirm'))) {
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
            setCwbHtml($button.prop('disabled', true), '<i class="fas fa-spinner fa-spin"></i> ' + cwbLabel('characterWorldUi.saving'));
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

                const finalEntryData = {
                    uid: targetUid,
                    content: finalContentToSave,
                    position: positionMap[insertionPosition] || 'before_character_definition',
                    order: isNaN(insertionOrder) ? 7001 : insertionOrder,
                };

                if (insertionPosition === 'at_depth') {
                    finalEntryData.depth = isNaN(insertionDepth) ? 0 : insertionDepth;
                } else {
                    finalEntryData.depth = null;
                }

                logDebug(`[DEBUG] 最终保存数据 UID:${targetUid}`, {
                    position: finalEntryData.position,
                    depth: finalEntryData.depth,
                    order: finalEntryData.order,
                    hasDepthField: 'depth' in finalEntryData
                });

                await amilyHelper.setLorebookEntries(book, [finalEntryData]);
                showToastr('success', t('characterWorldUi.viewer.saved'));
            } catch (error) {
                logError('保存角色卡失败:', error);
                showToastr('error', t('characterWorldUi.saveFailed', { error: error.message }), { escapeHtml: true });
            } finally {
                setCwbText($button.prop('disabled', false), 'characterWorldUi.viewer.save');
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
                showToastr('warning', t('characterWorldUi.world.missing'));
                $('body').append(createCharCardViewerPopupHtml([]));
                bindCharCardViewerPopupEvents($(`#${CHAR_CARD_VIEWER_POPUP_ID}`));
                return;
            }
            const allEntries = await amilyHelper.getLorebookEntries(book);
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
                    try {
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
                    } catch (e) {
                        logError(`解析角色条目失败 (UID: ${entry.uid})，已跳过。`, e);
                        return null;
                    }
                })
                .filter(c => c && c.parsed && Object.keys(c.parsed).length > 0);
            
            displayItems = displayItems.concat(characterEntries);

            const popupHtml = createCharCardViewerPopupHtml(displayItems);
            $('body').append(popupHtml);
            const $popup = $(`#${CHAR_CARD_VIEWER_POPUP_ID}`);
            bindCharCardViewerPopupEvents($popup);
        } catch (error) {
            logError('无法显示角色卡查看器:', error);
            showToastr('error', t('characterWorldUi.viewer.loadFailed'));
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
            initializeCwbI18n($existingButton, 'viewerButton');
            console.log('[CWB] Char card viewer button already exists');
            setTimeout(() => {
                const shouldShow = isCwbEnabled() && state.viewerEnabled;
                $existingButton.toggle(shouldShow);
                console.log(`[CWB] Force updated existing button visibility: ${shouldShow}`);
            }, 100);
            return;
        }
        
        const buttonHtml = `<div id="${CHAR_CARD_VIEWER_BUTTON_ID}" title="${escapeHtml(t('characterWorldUi.viewer.open'))}" data-cwb-i18n-title="characterWorldUi.viewer.open" class="fa-solid fa-book-open"></div>`;
        $('body').append(buttonHtml);
        const $viewerButton = $(`#${CHAR_CARD_VIEWER_BUTTON_ID}`);
        initializeCwbI18n($viewerButton, 'viewerButton');
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
            configManager.set('cwb_api_key', value);
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

        // cwb 槽分配 profile 后，温度/maxTokens 由 profile 权威控制（T-006 informational 化）
        watchProfileSliderGuard('cwb', ['#cwb-temperature', '#cwb-max-tokens']);

        $('#cwb-test-connection').off('click').on('click', async function() {
            const $button = $(this);
            setCwbHtml($button.prop('disabled', true), '<i class="fas fa-spinner fa-spin"></i> ' + cwbLabel('characterWorldUi.api.testing'));
            
            try {
                await testCwbConnection();
            } catch (error) {
                console.error('[CWB] 测试连接失败:', error);
            } finally {
                setCwbHtml($button.prop('disabled', false), '<i class="fas fa-plug"></i> ' + cwbLabel('characterWorldUi.api.test'));
            }
        });

        $('#cwb-fetch-models').off('click').on('click', async function() {
            const $button = $(this);
            setCwbHtml($button.prop('disabled', true), '<i class="fas fa-spinner fa-spin"></i> ' + cwbLabel('characterWorldUi.api.fetching'));
            
            try {
                const models = await fetchCwbModels();
                const $modelSelect = $('#cwb-model');
                $modelSelect.empty();
                
                if (models && models.length > 0) {
                    models.forEach(model => {
                        $modelSelect.append(new Option(model.name, model.id));
                    });
                    showToastr('success', t('characterWorldUi.api.modelsFetched', { count: models.length }));
                } else {
                    $modelSelect.append(setCwbText(new Option('', ''), 'characterWorldUi.api.noModels'));
                    showToastr('warning', t('characterWorldUi.api.noModelsFound'));
                }
            } catch (error) {
                console.error('[CWB] 获取模型失败:', error);
                $('#cwb-model').empty().append(setCwbText(new Option('', ''), 'characterWorldUi.api.fetchFailed'));
            } finally {
                setCwbHtml($button.prop('disabled', false), '<i class="fas fa-download"></i> ' + cwbLabel('characterWorldUi.api.fetch'));
            }
        });
    }
