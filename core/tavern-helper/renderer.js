import { eventSource, event_types } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import { extensionName } from '../../utils/settings.js';

const settings = {
    sandboxMode: false,
    useBlob: false,
    wrapperIframe: true,
    renderEnabled: true
};

const winMap = new Map();
let lastHeights = new WeakMap();
const blobUrls = new WeakMap();
const hashToBlobUrl = new Map();
const blobLRU = [];
const BLOB_CACHE_LIMIT = 32;

const viewport_adjust_script = `
<script>
window.addEventListener("message", function (event) {
    if (event.data && event.data.request === "updateViewportHeight") {
        const newHeight = event.data.newHeight;
        document.documentElement.style.setProperty("--viewport-height", newHeight + "px");
    }
});
</script>
`;

function processAllVhUnits(htmlContent) {
    const viewportHeight = window.innerHeight;
  
    let processedContent = htmlContent.replace(
      /((?:document\.body\.style\.minHeight|\.style\.minHeight|setProperty\s*\(\s*['"]min-height['"])\s*[=,]\s*['"`])([^'"`]*?)(['"`])/g,
      (match, prefix, value, suffix) => {
        if (value.includes('vh')) {
          const convertedValue = value.replace(/(\d+(?:\.\d+)?)vh/g, (num) => {
            const numValue = parseFloat(num);
            if (numValue === 100) {
              return `var(--viewport-height, ${viewportHeight}px)`;
            } else {
              return `calc(var(--viewport-height, ${viewportHeight}px) * ${numValue / 100})`;
            }
          });
          return prefix + convertedValue + suffix;
        }
        return match;
      },
    );
  
    processedContent = processedContent.replace(/min-height:\s*([^;]*vh[^;]*);/g, expression => {
      const processedExpression = expression.replace(/(\d+(?:\.\d+)?)vh/g, num => {
        const numValue = parseFloat(num);
        if (numValue === 100) {
          return `var(--viewport-height, ${viewportHeight}px)`;
        } else {
          return `calc(var(--viewport-height, ${viewportHeight}px) * ${numValue / 100})`;
        }
      });
      return `${processedExpression};`;
    });
  
    processedContent = processedContent.replace(
      /style\s*=\s*["']([^"']*min-height:\s*[^"']*vh[^"']*?)["']/gi,
      (match, styleContent) => {
        const processedStyleContent = styleContent.replace(/min-height:\s*([^;]*vh[^;]*)/g, (expression) => {
          const processedExpression = expression.replace(/(\d+(?:\.\d+)?)vh/g, num => {
            const numValue = parseFloat(num);
            if (numValue === 100) {
              return `var(--viewport-height, ${viewportHeight}px)`;
            } else {
              return `calc(var(--viewport-height, ${viewportHeight}px) * ${numValue / 100})`;
            }
          });
          return processedExpression;
        });
        return match.replace(styleContent, processedStyleContent);
      },
    );
  
    return processedContent;
}

function generateUniqueId() {
    return `amily2-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function shouldRenderContentByBlock(codeBlock) {
    if (!codeBlock) return false;
    const content = (codeBlock.textContent || '').trim();
    if (!content) return false;
    return /^\s*<!doctype html/i.test(content) || /^\s*<html/i.test(content) || /<script/i.test(content);
}

function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) + h) ^ str.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
}

function buildResourceHints(html) {
    const urls = Array.from(new Set((html.match(/https?:\/\/[^"'()\s]+/gi) || []).map(u => { try { return new URL(u).origin } catch { return null } }).filter(Boolean)));
    let hints = "";
    const maxHosts = 6;
    for (let i = 0; i < Math.min(urls.length, maxHosts); i++) {
        const origin = urls[i];
        hints += `<link rel="dns-prefetch" href="${origin}">`;
        hints += `<link rel="preconnect" href="${origin}" crossorigin>`;
    }
    let preload = "";
    const font = (html.match(/https?:\/\/[^"'()\s]+\.(?:woff2|woff|ttf|otf)/i) || [])[0];
    if (font) {
        const type = font.endsWith(".woff2") ? "font/woff2" : font.endsWith(".woff") ? "font/woff" : font.endsWith(".ttf") ? "font/ttf" : "font/otf";
        preload += `<link rel="preload" as="font" href="${font}" type="${type}" crossorigin fetchpriority="high">`;
    }
    const css = (html.match(/https?:\/\/[^"'()\s]+\.css/i) || [])[0];
    if (css) {
        preload += `<link rel="preload" as="style" href="${css}" crossorigin fetchpriority="high">`;
    }
    const img = (html.match(/https?:\/\/[^"'()\s]+\.(?:png|jpg|jpeg|webp|gif|svg)/i) || [])[0];
    if (img) {
        preload += `<link rel="preload" as="image" href="${img}" crossorigin fetchpriority="high">`;
    }
    return hints + preload;
}

function iframeClientScript() {
    return `
(function(){
  function measureVisibleHeight(){
    try{
      var doc = document;
      var target = doc.querySelector('.calendar-wrapper') || doc.body;
      if(!target) return 0;
      var minTop = Infinity, maxBottom = 0;
      var addRect = function(el){
        try{
          var r = el.getBoundingClientRect();
          if(r && r.height > 0){
            if(minTop > r.top) minTop = r.top;
            if(maxBottom < r.bottom) maxBottom = r.bottom;
          }
        }catch(e){}
      };
      addRect(target);
      var children = target.children || [];
      for(var i=0;i<children.length;i++){
        var child = children[i];
        if(!child) continue;
        try{
          var s = window.getComputedStyle(child);
          if(s.display === 'none' || s.visibility === 'hidden') continue;
          if(!child.offsetParent && s.position !== 'fixed') continue;
        }catch(e){}
        addRect(child);
      }
      return maxBottom > 0 ? Math.ceil(maxBottom - Math.min(minTop, 0)) : (target.scrollHeight || 0);
    }catch(e){
      return (document.body && document.body.scrollHeight) || 0;
    }
  }  function post(m){ try{ parent.postMessage(m,'*') }catch(e){} }
  var rafPending=false, lastH=0;
  var HYSTERESIS = 2;
  function send(force){
    if(rafPending && !force) return;
    rafPending = true;
    requestAnimationFrame(function(){
      rafPending = false;
      var h = measureVisibleHeight();
      if(force || Math.abs(h - lastH) >= HYSTERESIS){
        lastH = h;
        post({height:h, force:!!force});
      }
    });
  }
  try{ send(true) }catch(e){}
  document.addEventListener('DOMContentLoaded', function(){ send(true) }, {once:true});
  window.addEventListener('load', function(){ send(true) }, {once:true});
  try{
    if(document.fonts){
      document.fonts.ready.then(function(){ send(true) }).catch(function(){});
      if(document.fonts.addEventListener){
        document.fonts.addEventListener('loadingdone', function(){ send(true) });
        document.fonts.addEventListener('loadingerror', function(){ send(true) });
      }
    }
  }catch(e){}
  ['transitionend','animationend'].forEach(function(evt){
    document.addEventListener(evt, function(){ send(false) }, {passive:true, capture:true});
  });
  try{
    var root = document.querySelector('.calendar-wrapper') || document.body || document.documentElement;
    var ro = new ResizeObserver(function(){ send(false) });
    ro.observe(root);
  }catch(e){
    try{
      var rootMO = document.querySelector('.calendar-wrapper') || document.body || document.documentElement;
      new MutationObserver(function(){ send(false) })
        .observe(rootMO, {childList:true, subtree:true, attributes:true, characterData:true});
    }catch(e){}
    window.addEventListener('resize', function(){ send(false) }, {passive:true});
  }
  window.addEventListener('message', function(e){
    var d = e && e.data || {};
    if(d && d.type === 'probe') setTimeout(function(){ send(true) }, 10);
  });
})();`;
}

function buildWrappedHtml(html, needsVh) {
    const origin = (typeof location !== 'undefined' && location.origin) ? location.origin : '';
    const baseTag = settings && settings.useBlob ? `<base href="${origin}/">` : "";
    const headHints = buildResourceHints(html);
    const vhFix = `<style>html,body{height:auto!important;min-height:0!important;max-height:none!important}.profile-container,[style*="100vh"]{height:auto!important;min-height:600px!important}[style*="height:100%"]{height:auto!important;min-height:100%!important}</style>`;
    const vhStyle = needsVh ? `<style>:root{--viewport-height:${window.innerHeight}px;}</style>` : '';
    const vhScript = needsVh ? viewport_adjust_script : '';

    const apiScript = `
<script>
    window.makeRequest = function(request, data) {
        return new Promise(function(resolve, reject) {
            var uid = Date.now() + Math.random();
            var callbackRequest = request + '_callback';

            function handleMessage(event) {
                var msgData = event.data || {};
                if (msgData.request === callbackRequest && msgData.uid === uid) {
                    window.removeEventListener('message', handleMessage);
                    if (msgData.error) {
                        reject(new Error(msgData.error));
                    } else {
                        resolve(msgData.result);
                    }
                }
            }

            window.addEventListener('message', handleMessage);

            setTimeout(function() {
                window.removeEventListener('message', handleMessage);
                reject(new Error('请求 "' + request + '" 超时 (30秒)'));
            }, 30000);

            window.parent.postMessage({
                source: 'amily2-iframe-request',
                request: request,
                uid: uid,
                data: data
            }, '*');
        });
    };

    window.AmilyHelper = {
        getChatMessages: function(range, options) {
            return makeRequest('getChatMessages', { range: range, options: options });
        },
        setChatMessages: function(messages, options) {
            return makeRequest('setChatMessages', { messages: messages, options: options });
        },
        setChatMessage: function(index, content) {
            return makeRequest('setChatMessage', { index: index, content: content });
        },
        createChatMessages: function(messages, options) {
            return makeRequest('createChatMessages', { messages: messages, options: options });
        },
        deleteChatMessages: function(ids, options) {
            return makeRequest('deleteChatMessages', { ids: ids, options: options });
        },
        getLorebooks: function() {
            return makeRequest('getLorebooks', {});
        },
        getCharLorebooks: function(options) {
            return makeRequest('getCharLorebooks', { options: options });
        },
        getLorebookEntries: function(bookName) {
            return makeRequest('getLorebookEntries', { bookName: bookName });
        },
        setLorebookEntries: function(bookName, entries) {
            return makeRequest('setLorebookEntries', { bookName: bookName, entries: entries });
        },
        createLorebookEntries: function(bookName, entries) {
            return makeRequest('createLorebookEntries', { bookName: bookName, entries: entries });
        },
        createLorebook: function(bookName) {
            return makeRequest('createLorebook', { bookName: bookName });
        },
        triggerSlash: function(command) {
            return makeRequest('triggerSlash', { command: command });
        },
        getLastMessageId: function() {
            return makeRequest('getLastMessageId', {});
        },
        toastr: function(type, message, title) {
            return makeRequest('toastr', { type: type, message: message, title: title });
        }
    };

    if (!window.TavernHelper) {
        window.TavernHelper = window.AmilyHelper;
        console.log('[Amily2-Iframe] TavernHelper 别名已创建');
    } else {
        console.log('[Amily2-Iframe] 检测到已存在的 TavernHelper,保持原有实现');
    }

    window.triggerSlash = function(command) {
        return makeRequest('triggerSlash', { command: command });
    };

    window.getChatMessages = function(range, options) {
        return makeRequest('getChatMessages', { range: range, options: options });
    };

    window.setChatMessages = function(messages, options) {
        return makeRequest('setChatMessages', { messages: messages, options: options });
    };

    window.setChatMessage = function(field_values, message_id, options) {
        return makeRequest('setChatMessage', { 
            field_values: field_values, 
            message_id: message_id, 
            options: options || {} 
        });
    };

    window.switchSwipe = function(messageIndex, swipeIndex) {
        return makeRequest('switchSwipe', { messageIndex: messageIndex, swipeIndex: swipeIndex });
    };

    window.createChatMessages = function(messages, options) {
        return makeRequest('createChatMessages', { messages: messages, options: options });
    };

    window.deleteChatMessages = function(ids, options) {
        return makeRequest('deleteChatMessages', { ids: ids, options: options });
    };

    window.getLorebooks = function() {
        return makeRequest('getLorebooks', {});
    };

    window.getCharLorebooks = function(options) {
        return makeRequest('getCharLorebooks', { options: options });
    };

    window.getLorebookEntries = function(bookName) {
        return makeRequest('getLorebookEntries', { bookName: bookName });
    };

    window.setLorebookEntries = function(bookName, entries) {
        return makeRequest('setLorebookEntries', { bookName: bookName, entries: entries });
    };

    window.createLorebookEntries = function(bookName, entries) {
        return makeRequest('createLorebookEntries', { bookName: bookName, entries: entries });
    };

    window.createLorebook = function(bookName) {
        return makeRequest('createLorebook', { bookName: bookName });
    };

    window.getLastMessageId = function() {
        return makeRequest('getLastMessageId', {});
    };

    window.getVariables = function(options) {
        return makeRequest('getVariables', { options: options });
    };

    window.setVariables = function(variables, options) {
        return makeRequest('setVariables', { variables: variables, options: options });
    };

    window.deleteVariable = function(variablePath, options) {
        return makeRequest('deleteVariable', { variablePath: variablePath, options: options });
    };

    window.getCharData = function(name) {
        return makeRequest('getCharData', { name: name });
    };

    window.getCharAvatarPath = function(name) {
        return makeRequest('getCharAvatarPath', { name: name });
    };

    window.getLorebookSettings = function() {
        return makeRequest('getLorebookSettings', {});
    };

    window.setLorebookSettings = function(settings) {
        return makeRequest('setLorebookSettings', { settings: settings });
    };

    window.getChatLorebook = function() {
        return makeRequest('getChatLorebook', {});
    };

    window.setChatLorebook = function(lorebook) {
        return makeRequest('setChatLorebook', { lorebook: lorebook });
    };

    window.substitudeMacros = function(text) {
        return makeRequest('substitudeMacros', { text: text });
    };

    window.toastr = {
        success: function(message, title) {
            return makeRequest('toastr', { type: 'success', message: message, title: title });
        },
        info: function(message, title) {
            return makeRequest('toastr', { type: 'info', message: message, title: title });
        },
        warning: function(message, title) {
            return makeRequest('toastr', { type: 'warning', message: message, title: title });
        },
        warn: function(message, title) {
            return makeRequest('toastr', { type: 'warning', message: message, title: title });
        },
        error: function(message, title) {
            return makeRequest('toastr', { type: 'error', message: message, title: title });
        }
    };

    console.log('[Amily2-Iframe] 完整的 API 已加载到全局作用域');
    console.log('[Amily2-Iframe] 可用的全局对象: AmilyHelper, TavernHelper');
    console.log('[Amily2-Iframe] 可用的全局函数: triggerSlash, getChatMessages, setChatMessage, toastr, 等');
</script>
<script type="module" src="/scripts/extensions/third-party/${extensionName}/core/tavern-helper/iframe_client.js"></script>
`;

    const injectionBlock = `
${baseTag}
<script>${iframeClientScript()}</script>
${headHints}
${vhFix}
${vhStyle}
${apiScript}
${vhScript}
`;

    const isFullHtml = /<html/i.test(html) && /<\/html>/i.test(html);

    if (isFullHtml) {
        if (html.includes('</head>')) {
            return html.replace('</head>', `${injectionBlock}</head>`);
        } else if (html.includes('<body')) {
            return html.replace('<body', `<head>${injectionBlock}</head><body`);
        }
        return `<!DOCTYPE html>${injectionBlock}${html}`;
    }

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="color-scheme" content="dark light">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>html,body{margin:0;padding:0;background:transparent;font-family:inherit;color:inherit}</style>
${injectionBlock}
</head>
<body>${html}</body></html>`;
}


function getOrCreateWrapper(preEl) {
    let wrapper = preEl.previousElementSibling;
    if (!wrapper || !wrapper.classList.contains('amily2-iframe-wrapper')) {
        wrapper = document.createElement('div');
        wrapper.className = 'amily2-iframe-wrapper';
        wrapper.style.cssText = 'margin:0;';
        preEl.parentNode.insertBefore(wrapper, preEl);
    }
    return wrapper;
}

function registerIframeMapping(iframe, wrapper) {
    const tryMap = () => {
        try {
            if (iframe && iframe.contentWindow) {
                winMap.set(iframe.contentWindow, { iframe, wrapper });
                return true;
            }
        } catch (e) { }
        return false;
    };
    if (tryMap()) return;
    let tries = 0;
    const t = setInterval(() => {
        tries++;
        if (tryMap() || tries > 20) clearInterval(t);
    }, 25);
}

function handleIframeMessage(event) {
    const data = event.data || {};
    let rec = winMap.get(event.source);
    if (!rec || !rec.iframe) {
        const iframes = document.querySelectorAll('iframe.amily2-iframe');
        for (const iframe of iframes) {
            if (iframe.contentWindow === event.source) {
                rec = { iframe, wrapper: iframe.parentElement };
                winMap.set(event.source, rec);
                break;
            }
        }
    }
    if (rec && rec.iframe && typeof data.height === 'number') {
        const next = Math.max(0, Number(data.height) || 0);
        if (next < 1) return;
        const prev = lastHeights.get(rec.iframe) || 0;
        if (!data.force && Math.abs(next - prev) < 1) return;
        lastHeights.set(rec.iframe, next);
        requestAnimationFrame(() => { rec.iframe.style.height = `${next}px`; });
    }
}

function setIframeBlobHTML(iframe, fullHTML, codeHash) {
    const existing = hashToBlobUrl.get(codeHash);
    if (existing) {
        iframe.src = existing;
        blobUrls.set(iframe, existing);
        return;
    }
    const blob = new Blob([fullHTML], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    iframe.src = url;
    blobUrls.set(iframe, url);
    hashToBlobUrl.set(codeHash, url);
    blobLRU.push(codeHash);
    while (blobLRU.length > BLOB_CACHE_LIMIT) {
        const old = blobLRU.shift();
        const u = hashToBlobUrl.get(old);
        hashToBlobUrl.delete(old);
        try { URL.revokeObjectURL(u) } catch (e) { }
    }
}

function releaseIframeBlob(iframe) {
    try {
        const url = blobUrls.get(iframe);
        if (url) URL.revokeObjectURL(url);
        blobUrls.delete(iframe);
    } catch (e) { }
}

function renderHtmlInIframe(htmlContent, container, preElement) {
    try {
        let processedHtml = htmlContent;
        let needsVh = false;
        
        const hasMinVh = /min-height:\s*[^;]*vh/.test(htmlContent);
        const hasJsVhUsage = /\d+vh/.test(htmlContent);
        
        if (hasMinVh || hasJsVhUsage) {
            processedHtml = processAllVhUnits(htmlContent);
            needsVh = true;
        }

        const originalHash = djb2(htmlContent);
        const iframe = document.createElement('iframe');
        iframe.id = generateUniqueId();
        iframe.className = 'amily2-iframe';
        iframe.style.cssText = 'width:100%;border:none;background:transparent;overflow:hidden;height:0;margin:0;padding:0;display:block;contain:layout paint style;will-change:height;min-height:50px';
        iframe.setAttribute('frameborder', '0');
        iframe.setAttribute('scrolling', 'no');
        iframe.loading = 'eager';
        // 始终使用严格的沙箱策略，移除 allow-same-origin 以防止XSS攻击。
        // 仅允许脚本、表单、弹窗和模态框。
        // allow-popups-to-escape-sandbox 允许弹窗（如新标签页）摆脱沙箱限制，这对于外部链接是必要的。
        // allow-downloads 允许文件下载。
        iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads');
        
        if (needsVh) {
            iframe.dataset.needsVh = 'true';
        }

        const wrapper = getOrCreateWrapper(preElement);
        wrapper.querySelectorAll('.amily2-iframe').forEach(old => {
            try { old.src = 'about:blank'; } catch (e) { }
            releaseIframeBlob(old);
            old.remove();
        });
        const codeHash = djb2(htmlContent);
        const full = buildWrappedHtml(processedHtml, needsVh);
        if (settings.useBlob) {
            setIframeBlobHTML(iframe, full, codeHash);
        } else {
            iframe.srcdoc = full;
        }
        wrapper.appendChild(iframe);
        preElement.classList.remove('amily2-show');
        preElement.style.display = 'none';
        registerIframeMapping(iframe, wrapper);
        try { iframe.contentWindow?.postMessage({ type: 'probe' }, '*'); } catch (e) { }
        preElement.dataset.amily2Final = 'true';
        preElement.dataset.amily2Hash = originalHash;
        return iframe;
    } catch (err) {
        return null;
    }
}

function processCodeBlocks(messageElement) {
    if (extension_settings[extensionName].amily_render_enabled === false) return;
    try {
        const codeBlocks = messageElement.querySelectorAll('pre > code');
        codeBlocks.forEach(codeBlock => {
            const preElement = codeBlock.parentElement;
            const should = shouldRenderContentByBlock(codeBlock);
            const html = codeBlock.textContent || '';
            const hash = djb2(html);
            const isFinal = preElement.dataset.amily2Final === 'true';
            const same = preElement.dataset.amily2Hash === hash;
            if (isFinal && same) return;
            if (should) {
                renderHtmlInIframe(html, preElement.parentNode, preElement);
            } else {
                preElement.classList.add('amily2-show');
                preElement.removeAttribute('data-amily2-final');
                preElement.removeAttribute('data-amily2-hash');
                preElement.style.display = '';
            }
            preElement.dataset.amily2Bound = 'true';
        });
    } catch (err) {
        console.error('[Amily2-Renderer] Error during processCodeBlocks:', err);
    }
}

function processMessageById(messageId) {
    const messageElement = document.querySelector(`div.mes[mesid="${messageId}"] .mes_text`);
    if (!messageElement) return;
    processCodeBlocks(messageElement);
}

export function initializeRenderer() {
    if (window.isXiaobaixEnabled) {
        console.log('[Amily2-Renderer] 检测到 LittleWhiteBox 已激活，为避免冲突，Amily2 渲染器已禁用。');
        return;
    }

    const handleMessage = (data) => {
        const messageId = typeof data === 'object' ? data.messageId : data;
        if (messageId == null) return;
        console.log('[Amily2-Renderer] 处理消息渲染:', messageId);
        setTimeout(() => processMessageById(messageId), 50);
    };

    eventSource.on(event_types.MESSAGE_RECEIVED, handleMessage);
    eventSource.on(event_types.MESSAGE_UPDATED, handleMessage);
    eventSource.on(event_types.MESSAGE_SWIPED, handleMessage);
    eventSource.on(event_types.MESSAGE_EDITED, handleMessage);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, handleMessage);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, handleMessage);
    eventSource.on(event_types.IMPERSONATE_READY, handleMessage);

    eventSource.on(event_types.CHAT_CHANGED, () => {
        console.log('[Amily2-Renderer] 聊天已切换,重新渲染所有 iframe');
        setTimeout(renderAllIframes, 100);
    });

    window.addEventListener('message', handleIframeMessage);

    window.addEventListener('resize', function () {
        const viewportHeight = window.innerHeight;
        const iframes = document.querySelectorAll('iframe.amily2-iframe');
        iframes.forEach(iframe => {
            if (iframe.dataset.needsVh === 'true') {
                iframe.contentWindow?.postMessage({
                    request: 'updateViewportHeight',
                    newHeight: viewportHeight
                }, '*');
            }
        });
    });
    
    console.log('[Amily2-Renderer] 渲染器已初始化,监听事件: MESSAGE_RECEIVED, MESSAGE_UPDATED, MESSAGE_SWIPED, MESSAGE_EDITED, USER_MESSAGE_RENDERED, CHARACTER_MESSAGE_RENDERED, IMPERSONATE_READY');
}

export function renderAllIframes() {
    const messages = document.querySelectorAll('.mes');
    messages.forEach(message => {
        const messageId = message.getAttribute('mesid');
        if (messageId) {
            processMessageById(messageId);
        }
    });
}

export function clearAllIframes() {
    const iframes = document.querySelectorAll('.amily2-iframe');
    iframes.forEach(iframe => {
        const wrapper = iframe.parentElement;
        if (wrapper && wrapper.classList.contains('amily2-iframe-wrapper')) {
            const preElement = wrapper.nextElementSibling;
            if (preElement && preElement.tagName === 'PRE') {
                preElement.classList.add('amily2-show');
                preElement.style.display = '';
            }
            wrapper.remove();
        }
    });
}
