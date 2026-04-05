'use strict';

import {
    extension_settings
} from '/scripts/extensions.js';
import {
    buildGoogleEmbeddingRequest,
    parseGoogleEmbeddingResponse,
    buildGoogleEmbeddingApiUrl
} from './utils/googleAdapter.js';
import { getSlotProfile } from './api/api-resolver.js';

const MODULE_NAME = 'hanlinyuan-rag-core';
const GOOGLE_API_BASE_URL = 'https://generativelanguage.googleapis.com';

function getSettings() {
    const context = SillyTavern.getContext();
    if (!context || !context.extensionSettings || !context.extensionSettings[MODULE_NAME]) {
        console.error('[翰林院-API] 无法获取设置，API调用可能失败。');
        return {
            retrieval: {},
            rerank: {}
        };
    }
    return context.extensionSettings[MODULE_NAME];
}

/**
 * 获取 Embedding 配置，优先从 ragEmbed 槽位 Profile 读取。
 * Profile 存在时映射为 custom endpoint，覆盖旧 settings。
 */
export async function getEmbedRetrievalSettings() {
    const profile = await getSlotProfile('ragEmbed');
    if (profile) {
        return {
            apiEndpoint:    'custom',
            customApiUrl:   profile.apiUrl,
            apiKey:         profile.apiKey ?? '',
            embeddingModel: profile.model,
            batchSize:      getSettings().retrieval?.batchSize ?? 5,
        };
    }
    return getSettings().retrieval || {};
}

/**
 * 获取 Rerank 配置，优先从 ragRerank 槽位 Profile 读取。
 */
export async function getRerankSettings() {
    const profile = await getSlotProfile('ragRerank');
    if (profile) {
        return {
            url:     profile.apiUrl,
            apiKey:  profile.apiKey ?? '',
            model:   profile.model,
            top_n:   getSettings().rerank?.top_n ?? 10,
            apiMode: 'custom',
        };
    }
    return getSettings().rerank || {};
}

function normalizeApiResponse(responseData) {
    let data = responseData;
    if (typeof data === 'string') {
        try {
            data = JSON.parse(data);
        } catch (e) {
            console.error(`[翰林院-API] API响应JSON解析失败:`, e);
            return { error: { message: 'Invalid JSON response' } };
        }
    }
    if (data && typeof data.data === 'object' && data.data !== null && !Array.isArray(data.data)) {
        if (Object.hasOwn(data.data, 'data')) {
            data = data.data;
        }
    }
    if (data && data.data) { // for /v1/models
        return { data: data.data };
    }
    if (data && data.error) {
        return { error: data.error };
    }
    return data;
}

export function getSanitizedBaseUrl(rawApiUrl) {
    let baseUrl = rawApiUrl.trim();
    if (baseUrl.endsWith('/')) {
        baseUrl = baseUrl.slice(0, -1);
    }
    if (baseUrl.endsWith('/v1')) {
        baseUrl = baseUrl.slice(0, -3);
    }
    // 兼容处理 /embeddings
    if (baseUrl.endsWith('/embeddings')) {
        baseUrl = baseUrl.slice(0, -11);
    }
    return baseUrl;
}

export async function fetchEmbeddingModels(overrideSettings = null) {
    const settings = overrideSettings || await getEmbedRetrievalSettings();
    const { apiEndpoint, apiKey, customApiUrl } = settings;

    let modelsUrl;
    let headers = {};
    let responseParser;

    switch (apiEndpoint) {
        case 'google_direct':
            if (!apiKey) throw new Error("Google直连模式需要API Key。");
            
            const fetchGoogleModels = async (version) => {
                const url = `${GOOGLE_API_BASE_URL}/${version}/models?key=${apiKey}`;
                console.log(`[翰林院] 正在从 Google API (${version}) 获取模型列表: ${url}`);
                const response = await fetch(url);
                if (!response.ok) {
                    console.warn(`获取 Google API (${version}) 模型列表失败: ${response.status}`);
                    return [];
                }
                const json = await response.json();
                if (!json.models || !Array.isArray(json.models)) {
                    return [];
                }
                return json.models
                    .filter(model => model.supportedGenerationMethods?.includes('embedContent') || model.supportedGenerationMethods?.includes('batchEmbedContents'))
                    .map(model => model.name.replace('models/', ''));
            };

            const [v1Models, v1betaModels] = await Promise.all([
                fetchGoogleModels('v1'),
                fetchGoogleModels('v1beta')
            ]);

            const allModels = [...new Set([...v1Models, ...v1betaModels])].sort();
            return allModels;

        case 'custom':
            if (!customApiUrl) throw new Error("自定义模式需要API URL。");
            if (!apiKey) throw new Error("自定义模式需要API Key。");
            const customBaseUrl = getSanitizedBaseUrl(customApiUrl);
            modelsUrl = `${customBaseUrl}/v1/models`;
            headers = getApiHeaders(settings); // 这些模式需要认证头
            console.log(`[翰林院] 正在从 ${modelsUrl} 获取模型列表 (需要认证)...`);
            responseParser = (json) => {
                if (!json.data || !Array.isArray(json.data)) {
                    throw new Error("模型API的响应格式无效: 未找到 'data' 数组。");
                }
                return json.data.map(m => m.id).sort();
            };
            // 对于custom模式，需要继续执行下面的fetch
            break;
        
        case 'local_proxy':
        default:
            if (!customApiUrl) throw new Error("本地代理模式需要API URL。");
            const proxyBaseUrl = getSanitizedBaseUrl(customApiUrl);
            modelsUrl = `${proxyBaseUrl}/v1/models`;
            // 本地代理通常不需要认证头
            headers = { 'Content-Type': 'application/json' };
            console.log(`[翰林院] 正在从 ${modelsUrl} 获取模型列表 (无需认证)...`);
            responseParser = (json) => {
                if (!json.data || !Array.isArray(json.data)) {
                    throw new Error("模型API的响应格式无效: 未找到 'data' 数组。");
                }
                return json.data.map(m => m.id).sort();
            };
            break;
    }

    // 注意：st_backend case 和 google_direct case 已经提前返回，不会执行到这里
    if (!modelsUrl) {
        // 这个分支理论上不应该被执行，因为所有case都处理了
        throw new Error('无法确定获取模型的有效路径。');
    }

    const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: headers,
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`获取模型列表失败 (${response.status}): ${errorBody}`);
    }

    const data = await response.json();
    return responseParser(data);
}

export function getRerankBaseUrl(rawApiUrl) {
    let baseUrl = rawApiUrl.trim();
    if (baseUrl.endsWith('/')) {
        baseUrl = baseUrl.slice(0, -1);
    }
    if (baseUrl.endsWith('/v1')) {
        baseUrl = baseUrl.slice(0, -3);
    }
    // 兼容处理 /rerank
    if (baseUrl.endsWith('/rerank')) {
        baseUrl = baseUrl.slice(0, -7);
    }
    return baseUrl;
}

export async function fetchRerankModels() {
    const settings = await getRerankSettings();
    const { url, apiKey, apiMode = 'custom' } = settings;

    if (!url) {
        throw new Error("Rerank API URL 未提供。");
    }
    if (apiMode === 'custom' && !apiKey) {
        throw new Error("自定义模式下，Rerank API Key 未提供。");
    }

    const baseUrl = getRerankBaseUrl(url);
    const modelsUrl = `${baseUrl}/v1/models`;
    const headers = { 'Content-Type': 'application/json' };

    if (apiMode === 'custom') {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    console.log(`[翰林院-Rerank] 正在从 ${modelsUrl} 获取模型列表 (模式: ${apiMode})...`);

    const response = await fetch(modelsUrl, {
        method: 'GET',
        headers: headers,
    });

    if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`获取Rerank模型列表失败 (${response.status}): ${errorBody}`);
    }

    const data = await response.json();

    if (!data.data || !Array.isArray(data.data)) {
        throw new Error("Rerank模型API的响应格式无效: 未找到 'data' 数组。");
    }

    return data.data
        .map(m => m.id)
        .sort();
}

export async function executeRerank(query, documents, rerankSettings = null) {
    const resolved = rerankSettings || await getRerankSettings();
    const { url, apiKey, model, top_n, apiMode = 'custom' } = resolved;

    if (!url) throw new Error("Rerank API URL 未提供。");
    if (apiMode === 'custom' && !apiKey) throw new Error("自定义模式下，Rerank API Key 未提供。");

    const baseUrl = getRerankBaseUrl(url);
    const rerankUrl = `${baseUrl}/v1/rerank`;
    const headers = { 'Content-Type': 'application/json' };

    if (apiMode === 'custom') {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body = JSON.stringify({
        query: query,
        documents: documents,
        model: model,
        top_n: top_n,
    });

    console.log(`[翰林院-Rerank] 正在向 ${rerankUrl} 发送请求 (模式: ${apiMode})...`);

    const response = await fetch(rerankUrl, {
        method: 'POST',
        headers: headers,
        body: body,
    });

    if (!response.ok) {
        throw new Error(`Rerank API 请求失败 (${response.status}): ${await response.text()}`);
    }
    
    return await response.json();
}


export function getApiEndpointUrl(raw = false, overrideRetrieval = null) {
    const {
        apiEndpoint,
        customApiUrl
    } = overrideRetrieval || getSettings().retrieval;
    let url;
    switch (apiEndpoint) {
        case 'openai':
            url = 'https://api.openai.com';
            break;
        case 'azure':
        case 'custom':
            url = customApiUrl;
            break;
        default:
            url = 'https://api.openai.com';
            break;
    }
    if (raw) {
        return url;
    }
    // 默认情况下，返回拼接好 /v1/embeddings 的完整URL
    return getSanitizedBaseUrl(url) + '/v1/embeddings';
}

export function getApiHeaders(overrideRetrieval = null) {
    const headers = {
        'Content-Type': 'application/json'
    };
    const {
        apiKey,
        apiEndpoint
    } = overrideRetrieval || getSettings().retrieval;
    switch (apiEndpoint) {
        case 'openai':
        case 'custom':
            headers['Authorization'] = `Bearer ${apiKey}`;
            break;
        case 'azure':
            headers['api-key'] = apiKey;
            break;
    }
    return headers;
}

export async function getEmbeddings(texts, signal = null) {
    const settings = await getEmbedRetrievalSettings();
    const { apiEndpoint, customApiUrl, apiKey, embeddingModel, batchSize = 5 } = settings;

    const allEmbeddings = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        if (signal?.aborted) throw new Error('AbortError');
        const batch = texts.slice(i, i + batchSize);
        let batchEmbeddings = [];

        switch (apiEndpoint) {
            case 'google_direct':
                console.log('[翰林院-API] 使用Google直连模式获取向量。');
                if (!apiKey) throw new Error('Google直连模式需要API Key。');

                // 使用适配器构建URL和请求体
                const googleUrl = `${buildGoogleEmbeddingApiUrl(GOOGLE_API_BASE_URL, embeddingModel)}?key=${apiKey}`;
                const googleBody = buildGoogleEmbeddingRequest(batch, embeddingModel);

                console.log(`[翰林院-API] 发送到 Google API 的请求 URL: ${googleUrl}`);
                console.log(`[翰林院-API] 发送到 Google API 的请求体:`, JSON.stringify(googleBody, null, 2));

                const googleResponse = await fetch(googleUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(googleBody),
                    signal: signal,
                });

                if (!googleResponse.ok) {
                    const errorText = await googleResponse.text();
                    console.error(`[翰林院-API] Google API 错误响应: ${errorText}`);
                    throw new Error(`Google API Error: ${googleResponse.status} ${errorText}`);
                }
                const googleData = await googleResponse.json();
                console.log(`[翰林院-API] 从 Google API 收到的响应:`, JSON.stringify(googleData, null, 2));
                
                // 使用适配器解析响应
                batchEmbeddings = parseGoogleEmbeddingResponse(googleData, batch);
                break;

            case 'custom':
            case 'local_proxy':
            default:
                console.log(`[翰林院-API] 使用前端直连模式 (${apiEndpoint}) 获取向量。`);
                if (!apiKey && apiEndpoint === 'custom') {
                    // 本地代理可以没有key，但自定义通常需要
                    // throw new Error('自定义模式需要API Key。');
                }
                const url = getApiEndpointUrl(false, settings); // 使用已解析的 settings
                const headers = getApiHeaders(settings); // 使用已解析的 settings
                
                const response = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({
                        input: batch,
                        model: embeddingModel
                    }),
                    signal: signal,
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    throw new Error(`神力获取失败 ${response.status}: ${errorText}`);
                }
                const result = await response.json();
                if (result.data && Array.isArray(result.data)) {
                    batchEmbeddings = result.data.map(item => item.embedding);
                } else {
                     throw new Error('API返回的向量数据格式不正确。');
                }
                break;
        }

        if (batchEmbeddings.length !== batch.length) {
            throw new Error('获取到的向量数量与发送的文本数量不匹配。');
        }
        allEmbeddings.push(...batchEmbeddings);

        // 避免速率限制
        if (i + batchSize < texts.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    return allEmbeddings;
}

export async function testApiConnection() {
    await getEmbeddings(['测试连接']);
}
