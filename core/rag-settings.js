
'use strict';

export const defaultSettings = {
    retrieval: {
        enabled: false, 
        apiEndpoint: 'openai', 
        customApiUrl: 'https://api.siliconflow.cn/v1',
        apiKey: '',
        embeddingModel: 'text-embedding-3-small',
        notify: true,
        batchSize: 50, 
    },
    advanced: {
        chunkSize: 768,
        overlap: 50,
        matchThreshold: 0.5,
        queryMessageCount: 2,
        maxResults: 10,
    },
    injection: {
        template: '以下内容是翰林院向量化后注入的相关内容，是已经发生过的事情简短总结，但可能顺序会有些错乱，但已经对前后做出了标识，请自行判断顺序：\n<总结内容>\n{text}}\n</总结内容>\n【以上内容是已经发生过的事情，切莫以此作为剧情进展，只是作为提醒发生过的事情】',

        position: 1, 
        depth: 1,
        depth_role: 0,
    },
    condensation: {
        enabled: true,
        layerStart: 1,
        layerEnd: 10,
        messageTypes: { user: true, ai: true, hidden: false },
        tagExtractionEnabled: false,
        tags: '摘要',
        exclusionRules: [],
    },
    rerank: {
        enabled: false,
        url: 'https://api.siliconflow.cn/v1',
        apiKey: '', 
        model: 'Pro/BAAI/bge-reranker-v2-m3',
        top_n: 5,
        hybrid_alpha: 0.7,
        notify: true,
    },
    knowledgeBases: {},
};
