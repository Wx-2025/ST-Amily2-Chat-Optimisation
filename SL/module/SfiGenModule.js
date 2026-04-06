import { Module, ModuleBuilder } from './Module.js';
import { extension_settings, getContext } from '../../../../../extensions.js';
import { saveSettingsDebounced, saveChat, reloadCurrentChat, eventSource, event_types } from '../../../../../../script.js';
import { registerSlashCommand } from '../../../../../slash-commands.js';

const extensionName = 'ST-Amily2-Chat-Optimisation-Dev'; // Use main extension name for settings
const sfigenSettingsKey = 'sfigen_settings';

const defaultSettings = {
    api_key: '',
    model: 'Qwen/Qwen-Image',
    negative_prompt: '模糊, 低分辨率, 水印, 文字',
    image_size: '1664x928',
    steps: 50,
    cfg: 4.0,
    regex_tag: 'sfigen',
    prefix_prompt: ''
};

const builder = new ModuleBuilder()
    .name('SfiGen')
    .view('assets/siliconflow-image-gen.html')
    .strict(true)
    .required(['mount']);

export default class SfiGenModule extends Module {
    constructor() {
        super(builder);
        this.settings = {};
    }

    async init(ctx = {}) {
        await super.init(ctx);
        this._loadSettings();
        return this;
    }

    _loadSettings() {
        if (!extension_settings[extensionName]) {
            extension_settings[extensionName] = {};
        }
        if (!extension_settings[extensionName][sfigenSettingsKey]) {
            extension_settings[extensionName][sfigenSettingsKey] = { ...defaultSettings };
        }
        this.settings = extension_settings[extensionName][sfigenSettingsKey];
        
        // Ensure all default keys exist
        for (const key in defaultSettings) {
            if (!(key in this.settings)) {
                this.settings[key] = defaultSettings[key];
            }
        }
    }

    _saveSettings() {
        extension_settings[extensionName][sfigenSettingsKey] = this.settings;
        saveSettingsDebounced();
    }

    async mount() {
        if (this.el) {
            this.el.id = 'amily2_sfigen_panel';
            this.el.style.display = 'none';
        }

        this._bindUI();
        this._registerSlashCommand();
        this._bindEvents();
        this._bindButtonsGlobal();
    }

    _bindUI() {
        const $el = $(this.el);

        // Bind inputs
        $el.find('#sfigen_api_key').val(this.settings.api_key).on('input', (e) => {
            this.settings.api_key = $(e.target).val();
            this._saveSettings();
        });
        $el.find('#sfigen_model').val(this.settings.model).on('input', (e) => {
            this.settings.model = $(e.target).val();
            this._saveSettings();
        });
        $el.find('#sfigen_negative_prompt').val(this.settings.negative_prompt).on('input', (e) => {
            this.settings.negative_prompt = $(e.target).val();
            this._saveSettings();
        });
        $el.find('#sfigen_image_size').val(this.settings.image_size).on('change', (e) => {
            this.settings.image_size = $(e.target).val();
            this._saveSettings();
        });
        $el.find('#sfigen_steps').val(this.settings.steps).on('input', (e) => {
            this.settings.steps = $(e.target).val();
            this._saveSettings();
        });
        $el.find('#sfigen_cfg').val(this.settings.cfg).on('input', (e) => {
            this.settings.cfg = $(e.target).val();
            this._saveSettings();
        });
        $el.find('#sfigen_regex_tag').val(this.settings.regex_tag).on('input', (e) => {
            this.settings.regex_tag = $(e.target).val();
            this._saveSettings();
        });
        $el.find('#sfigen_prefix_prompt').val(this.settings.prefix_prompt).on('input', (e) => {
            this.settings.prefix_prompt = $(e.target).val();
            this._saveSettings();
        });

        // Bind style tags
        $el.find('.sfigen-style-tag').on('click', (e) => {
            const promptToAdd = $(e.target).data('prompt');
            const textarea = $el.find('#sfigen_prefix_prompt');
            let currentVal = textarea.val().trim();
            
            if (currentVal) {
                if (!currentVal.endsWith(',')) {
                    currentVal += ', ';
                } else {
                    currentVal += ' ';
                }
                textarea.val(currentVal + promptToAdd);
            } else {
                textarea.val(promptToAdd);
            }
            
            textarea.trigger('input');
            
            $(e.target).css('opacity', '0.5');
            setTimeout(() => $(e.target).css('opacity', '1'), 200);
        });

        // Bind back button
        $el.find('#amily2_sfigen_back_to_main').on('click', () => {
            $el.hide();
            $('#amily2_chat_optimiser > .plugin-features').show();
        });
    }

    async _generateImage(prompt) {
        let finalPrompt = prompt;
        if (this.settings.prefix_prompt && this.settings.prefix_prompt.trim() !== '') {
            finalPrompt = `${this.settings.prefix_prompt.trim()}, ${prompt}`;
        }
        
        console.log(`[SfiGen] 开始生成图片，最终提示词:`, finalPrompt);
        
        if (!this.settings.api_key) {
            console.warn(`[SfiGen] 未配置 API Key`);
            toastr.error('请先在扩展设置中配置 SiliconFlow API Key');
            return null;
        }

        const url = 'https://api.siliconflow.cn/v1/images/generations';
        const headers = {
            'Authorization': `Bearer ${this.settings.api_key}`,
            'Content-Type': 'application/json'
        };

        const body = {
            model: this.settings.model,
            prompt: finalPrompt,
            negative_prompt: this.settings.negative_prompt,
            image_size: this.settings.image_size,
            seed: Math.floor(Math.random() * 1000000000),
            num_inference_steps: parseInt(this.settings.steps),
            cfg: parseFloat(this.settings.cfg)
        };

        try {
            toastr.info('正在生成图片，请稍候...');
            const response = await fetch(url, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            
            if (data.images && data.images.length > 0) {
                toastr.success('图片生成成功！');
                return data.images[0].url;
            } else {
                throw new Error('API 返回数据中没有图片 URL');
            }
        } catch (error) {
            console.error(`[SfiGen] 生成图片失败:`, error);
            toastr.error(`生成图片失败: ${error.message}`);
            return null;
        }
    }

    _escapeHtml(unsafe) {
        return (unsafe || '').replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }


    _processMessageDOM(messageId) {
        const messageElement = $(`.mes[mesid="${messageId}"] .mes_text`);
        if (!messageElement.length) return;

        // 检查是否已经处理过，如果已经有容器，说明已经处理过了，直接返回
        if (messageElement.find('.sfigen-image-container').length > 0) {
            return;
        }

        let html = messageElement.html();
        const tag = this.settings.regex_tag || 'sfigen';
        
        let newHtml = html;
        let hasMatch = false;
        
        // 1. 匹配 [tag: prompt]
        const regexPrompt = new RegExp(`\\[${tag}:\\s*([^\\]]+)\\]`, 'gi');
        newHtml = newHtml.replace(regexPrompt, (match, prompt) => {
            hasMatch = true;
            const buttonId = `sfigen-btn-${messageId}-${Math.random().toString(36).substr(2, 9)}`;
            const safePrompt = this._escapeHtml(prompt);
            const safeMatch = this._escapeHtml(match);
            return `<div class="sfigen-image-container" data-message-id="${messageId}" data-prompt="${safePrompt}" data-original-tag="${safeMatch}" style="width: 96%; max-width: 600px; background: var(--SmartThemeBlurTintColor); border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); overflow: hidden; margin: 20px auto; padding: 15px; text-align: center; position: relative; z-index: 10;"><button id="${buttonId}" class="sfigen-generate-btn" style="background-color: var(--SmartThemeQuoteColor); color: var(--SmartThemeBodyColor); border: 1px solid var(--SmartThemeBorderColor); padding: 8px 20px; border-radius: 8px; cursor: pointer; pointer-events: auto; display: inline-block; font-weight: bold; transition: all 0.2s;"><i class="fa-solid fa-image"></i> 生成图片</button></div>`;
        });

        // 2. 匹配 [tag_img: prompt | url1,url2]
        const regexImg = new RegExp(`\\[${tag}_img:\\s*([^\\]]+)\\]`, 'gi');
        newHtml = newHtml.replace(regexImg, (match, content) => {
            hasMatch = true;
            
            let prompt = "未知提示词";
            let imageList = [];
            
            if (content.includes('|')) {
                const parts = content.split('|');
                prompt = parts[0].trim();
                imageList = parts[1].split(',').map(u => u.trim());
            } else {
                imageList = content.split(',').map(u => u.trim());
            }
            
            const displayUrl = imageList[imageList.length - 1];
            const buttonId = `sfigen-btn-${messageId}-${Math.random().toString(36).substr(2, 9)}`;
            const safePrompt = this._escapeHtml(prompt);
            const safeMatch = this._escapeHtml(match);
            
            let navHtml = '';
            if (imageList.length > 1) {
                navHtml = `<div style="display: flex; justify-content: center; gap: 10px; margin-top: 10px;">`;
                imageList.forEach((url, index) => {
                    const isActive = index === imageList.length - 1;
                    navHtml += `<button class="sfigen-nav-btn" data-url="${this._escapeHtml(url)}" style="width: 12px; height: 12px; border-radius: 50%; border: none; background-color: ${isActive ? 'var(--SmartThemeQuoteColor)' : 'var(--SmartThemeBorderColor)'}; cursor: pointer; padding: 0;"></button>`;
                });
                navHtml += `</div>`;
            }

            return `<div class="sfigen-image-container" data-message-id="${messageId}" data-prompt="${safePrompt}" data-original-tag="${safeMatch}" data-urls="${this._escapeHtml(imageList.join(','))}" style="width: 96%; max-width: 600px; background: var(--SmartThemeBlurTintColor); border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); overflow: hidden; margin: 20px auto; padding: 15px; text-align: center; position: relative; z-index: 10;">
                <div style="width: calc(100% - 4px); margin: 2px auto 15px auto; border: 2px solid rgba(0,0,0,0.15); border-radius: 8px; overflow: hidden; position: relative; cursor: pointer;" class="sfigen-img-wrapper">
                    <img src="${this._escapeHtml(displayUrl)}" class="sfigen-display-img" style="width: 100%; display: block; transition: transform 0.3s;" alt="CG" title="点击放大">
                    <div class="sfigen-img-overlay" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.3); display: flex; justify-content: center; align-items: center; opacity: 0; transition: opacity 0.2s;">
                        <i class="fa-solid fa-magnifying-glass-plus" style="color: white; font-size: 2em;"></i>
                    </div>
                </div>
                ${navHtml}
                <div style="display: flex; justify-content: center; gap: 10px; margin-top: 15px;">
                    <button id="${buttonId}" class="sfigen-generate-btn" style="background-color: var(--SmartThemeQuoteColor); color: var(--SmartThemeBodyColor); border: 1px solid var(--SmartThemeBorderColor); padding: 8px 20px; border-radius: 8px; cursor: pointer; pointer-events: auto; display: inline-block; font-weight: bold; transition: all 0.2s;"><i class="fa-solid fa-rotate-right"></i> 再次生成</button>
                    <button class="sfigen-save-btn" data-url="${this._escapeHtml(displayUrl)}" style="background-color: var(--SmartThemeQuoteColor); color: var(--SmartThemeBodyColor); border: 1px solid var(--SmartThemeBorderColor); padding: 8px 20px; border-radius: 8px; cursor: pointer; pointer-events: auto; display: inline-block; font-weight: bold; transition: all 0.2s;"><i class="fa-solid fa-download"></i> 保存图片</button>
                </div>
            </div>`;
        });

        if (hasMatch) {
            messageElement.html(newHtml);
        }
    }

    _bindEvents() {
        const handleMessageRender = (messageId) => {
            setTimeout(() => this._processMessageDOM(messageId), 50);
        };

        eventSource.on(event_types.USER_MESSAGE_RENDERED, handleMessageRender);
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleMessageRender);
        eventSource.on(event_types.MESSAGE_UPDATED, handleMessageRender);
        eventSource.on(event_types.MESSAGE_EDITED, handleMessageRender);
        eventSource.on(event_types.MESSAGE_SWIPED, handleMessageRender);

        eventSource.on(event_types.CHAT_CHANGED, () => {
            setTimeout(() => {
                $('.mes').each((_, el) => {
                    const messageId = $(el).attr('mesid');
                    if (messageId) {
                        this._processMessageDOM(messageId);
                    }
                });
            }, 500);
        });

        // Initial processing
        setTimeout(() => {
            $('.mes').each((_, el) => {
                const messageId = $(el).attr('mesid');
                if (messageId) {
                    this._processMessageDOM(messageId);
                }
            });
        }, 1000);
    }

    _bindButtonsGlobal() {
        $(document).off('click', '.sfigen-generate-btn');
        
        $(document).on('click', '.sfigen-generate-btn', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            
            const btn = $(e.currentTarget);
            const container = btn.closest('.sfigen-image-container');
            const prompt = container.data('prompt');
            const messageId = container.data('message-id');
            const originalTag = container.data('original-tag');
            
            btn.prop('disabled', true);
            btn.html('<i class="fa-solid fa-spinner fa-spin"></i> 生成中...');
            
            const imageUrl = await this._generateImage(prompt);
            
            if (imageUrl) {
                const tag = this.settings.regex_tag || 'sfigen';
                
                let existingUrls = container.data('urls') ? String(container.data('urls')).split(',') : [];
                existingUrls.push(imageUrl);
                const urlsString = existingUrls.join(',');
                
                const newTag = `[${tag}_img: ${prompt} | ${urlsString}]`;
                
                const context = getContext();
                const chat = context.chat;
                
                if (chat && chat[messageId]) {
                    const message = chat[messageId];
                    
                    // Fix: Use a more robust replacement strategy
                    // Sometimes originalTag might have been modified by markdown parser
                    // So we replace the whole tag block in the original message
                    const regexPrompt = new RegExp(`\\[${tag}:\\s*([^\\]]+)\\]`, 'gi');
                    const regexImg = new RegExp(`\\[${tag}_img:\\s*([^\\]]+)\\]`, 'gi');
                    
                    let replaced = false;
                    
                    // Try exact match first
                    if (message.mes.includes(originalTag)) {
                        message.mes = message.mes.replace(originalTag, newTag);
                        replaced = true;
                    } 
                    // If not found, try regex replacement
                    else {
                        message.mes = message.mes.replace(regexImg, (match, content) => {
                            if (content.includes(prompt)) {
                                replaced = true;
                                return newTag;
                            }
                            return match;
                        });
                        
                        if (!replaced) {
                            message.mes = message.mes.replace(regexPrompt, (match, p) => {
                                if (p.trim() === prompt.trim()) {
                                    replaced = true;
                                    return newTag;
                                }
                                return match;
                            });
                        }
                    }
                    
                    if (replaced) {
                        await saveChat();
                        
                        // 立即在前端替换 DOM，显示生成的图片
                        let navHtml = '';
                        if (existingUrls.length > 1) {
                            navHtml = `<div style="display: flex; justify-content: center; gap: 10px; margin-top: 10px;">`;
                            existingUrls.forEach((url, index) => {
                                const isActive = index === existingUrls.length - 1;
                                navHtml += `<button class="sfigen-nav-btn" data-url="${this._escapeHtml(url)}" style="width: 12px; height: 12px; border-radius: 50%; border: none; background-color: ${isActive ? 'var(--SmartThemeQuoteColor)' : 'var(--SmartThemeBorderColor)'}; cursor: pointer; padding: 0;"></button>`;
                            });
                            navHtml += `</div>`;
                        }

                        const newButtonId = `sfigen-btn-${messageId}-${Math.random().toString(36).substr(2, 9)}`;
                        const safePrompt = this._escapeHtml(prompt);
                        const safeNewTag = this._escapeHtml(newTag);
                        const safeUrlsString = this._escapeHtml(urlsString);
                        const safeImageUrl = this._escapeHtml(imageUrl);

                        const finalHtml = `<div class="sfigen-image-container" data-message-id="${messageId}" data-prompt="${safePrompt}" data-original-tag="${safeNewTag}" data-urls="${safeUrlsString}" style="width: 96%; max-width: 600px; background: var(--SmartThemeBlurTintColor); border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); overflow: hidden; margin: 20px auto; padding: 15px; text-align: center; position: relative; z-index: 10;">
                            <div style="width: calc(100% - 4px); margin: 2px auto 15px auto; border: 2px solid rgba(0,0,0,0.15); border-radius: 8px; overflow: hidden; position: relative; cursor: pointer;" class="sfigen-img-wrapper">
                                <img src="${safeImageUrl}" class="sfigen-display-img" style="width: 100%; display: block; transition: transform 0.3s;" alt="CG" title="点击放大">
                                <div class="sfigen-img-overlay" style="position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.3); display: flex; justify-content: center; align-items: center; opacity: 0; transition: opacity 0.2s;">
                                    <i class="fa-solid fa-magnifying-glass-plus" style="color: white; font-size: 2em;"></i>
                                </div>
                            </div>
                            ${navHtml}
                            <div style="display: flex; justify-content: center; gap: 10px; margin-top: 15px;">
                                <button id="${newButtonId}" class="sfigen-generate-btn" style="background-color: var(--SmartThemeQuoteColor); color: var(--SmartThemeBodyColor); border: 1px solid var(--SmartThemeBorderColor); padding: 8px 20px; border-radius: 8px; cursor: pointer; pointer-events: auto; display: inline-block; font-weight: bold; transition: all 0.2s;"><i class="fa-solid fa-rotate-right"></i> 再次生成</button>
                                <button class="sfigen-save-btn" data-url="${safeImageUrl}" style="background-color: var(--SmartThemeQuoteColor); color: var(--SmartThemeBodyColor); border: 1px solid var(--SmartThemeBorderColor); padding: 8px 20px; border-radius: 8px; cursor: pointer; pointer-events: auto; display: inline-block; font-weight: bold; transition: all 0.2s;"><i class="fa-solid fa-download"></i> 保存图片</button>
                            </div>
                        </div>`;
                        
                        container.replaceWith(finalHtml);
                        
                    } else {
                        console.warn(`[SfiGen] Could not find tag to replace in message ${messageId}`);
                        toastr.warning('图片已生成，但无法保存到聊天记录中。');
                    }
                }
            } else {
                btn.prop('disabled', false);
                btn.html('<i class="fa-solid fa-image"></i> 重新生成');
            }
        });

        // Image hover and zoom
        $(document).on('mouseenter', '.sfigen-img-wrapper', function() {
            $(this).find('.sfigen-img-overlay').css('opacity', '1');
            $(this).find('.sfigen-display-img').css('transform', 'scale(1.02)');
        }).on('mouseleave', '.sfigen-img-wrapper', function() {
            $(this).find('.sfigen-img-overlay').css('opacity', '0');
            $(this).find('.sfigen-display-img').css('transform', 'scale(1)');
        });

        $(document).on('click', '.sfigen-img-wrapper', function(e) {
            e.stopPropagation();
            const imgUrl = $(this).find('img').attr('src');
            
            const overlay = $(`
                <div id="sfigen-zoom-overlay" style="position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.9); z-index: 9999; display: flex; justify-content: center; align-items: center; cursor: zoom-out; opacity: 0; transition: opacity 0.3s;">
                    <img src="${imgUrl}" style="max-width: 95%; max-height: 95%; object-fit: contain; border-radius: 8px; box-shadow: 0 0 20px rgba(0,0,0,0.5); transform: scale(0.9); transition: transform 0.3s;">
                    <div style="position: absolute; top: 20px; right: 20px; color: white; font-size: 24px; cursor: pointer;"><i class="fa-solid fa-xmark"></i></div>
                </div>
            `);
            
            $('body').append(overlay);
            
            setTimeout(() => {
                overlay.css('opacity', '1');
                overlay.find('img').css('transform', 'scale(1)');
            }, 10);
            
            overlay.on('click', function() {
                overlay.css('opacity', '0');
                overlay.find('img').css('transform', 'scale(0.9)');
                setTimeout(() => overlay.remove(), 300);
            });
        });

        // Save image
        $(document).on('click', '.sfigen-save-btn', async function(e) {
            e.preventDefault();
            e.stopPropagation();
            const url = $(this).data('url');
            
            try {
                const response = await fetch(url);
                const blob = await response.blob();
                
                const downloadUrl = window.URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.style.display = 'none';
                a.href = downloadUrl;
                
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                a.download = `sfigen_${timestamp}.png`;
                
                document.body.appendChild(a);
                a.click();
                
                window.URL.revokeObjectURL(downloadUrl);
                document.body.removeChild(a);
                
                toastr.success('图片已保存到默认下载目录');
            } catch (error) {
                console.error(`[SfiGen] 保存图片失败:`, error);
                toastr.error('保存图片失败');
            }
        });

        // Nav buttons
        $(document).on('click', '.sfigen-nav-btn', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            const btn = $(this);
            const container = btn.closest('.sfigen-image-container');
            const targetUrl = btn.data('url');
            
            container.find('.sfigen-display-img').attr('src', targetUrl);
            container.find('.sfigen-save-btn').data('url', targetUrl);
            
            container.find('.sfigen-nav-btn').css('background-color', 'var(--SmartThemeBorderColor)');
            btn.css('background-color', 'var(--SmartThemeQuoteColor)');
        });
    }

    _registerSlashCommand() {
        registerSlashCommand('sfigen', async (args, value) => {
            if (!value) {
                toastr.warning('请提供提示词。例如: /sfigen 一个可爱的猫咪');
                return;
            }
            const imageUrl = await this._generateImage(value);
            if (imageUrl) {
                const context = getContext();
                const message = `<img src="${imageUrl}" alt="Generated Image" style="max-width: 100%; border-radius: 8px;" />`;
                
                context.chat.push({
                    name: 'System',
                    is_user: false,
                    is_system: true,
                    mes: message,
                    send_date: Date.now(),
                });
                await saveChat();
                
                if (typeof window.updateChat === 'function') {
                    window.updateChat();
                } else if (typeof window.updateMessageBlock === 'function') {
                    window.updateMessageBlock(context.chat.length - 1, context.chat[context.chat.length - 1]);
                } else {
                    await reloadCurrentChat();
                }
            }
        }, [], '使用 SiliconFlow 生成图片', true, true);
    }
}
