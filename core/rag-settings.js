
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
    injection_novel: {
        template: '以下内容是翰林院向量化后注入的原著小说剧情，但可能顺序会有些错乱，已经对前后做出了标识，请自行判断顺序：\n\n{{novel_text}}\n\n【以上内容是小说的原著剧情，切莫以此作为剧情进展，只是作为剧情的关联】',
        position: 1,
        depth: 2,
        depth_role: 0,
    },
    injection_chat: {
        template: '以下内容是翰林院向量化后注入的聊天对话记录，但可能顺序会有些错乱，已经对前后做出了标识，请自行判断顺序：\n\n{{chat_text}}\n\n【以上内容是对话的楼层记录，切莫以此作为剧情进展，只是作为相关提示】',
        position: 1,
        depth: 2,
        depth_role: 0,
    },
    injection_lorebook: {
        template: '以下内容是翰林院向量化后注入的世界书的条目内容（可能内含对话记录的总结），顺序可能会有些错乱，但已经对前后做出了标识，请自行判断顺序：\n\n{{lorebook_text}}\n\n【以上内容是从世界书中向量化后的内容，切莫以此作为剧情进展，只是作为已发生过的事情提醒】',
        position: 1,
        depth: 2,
        depth_role: 0,
    },
    injection_manual: {
        template: '以下内容是翰林院向量化后用户手动注入的内容，可能顺序会有些错乱，但已经对前后做出了标识，请自行判断顺序：\n\n{{manual_text}}\n\n【以上内容为用户手动向量化注入的内容，切莫以此作为剧情进展，只是作为相关提示】',
        position: 1,
        depth: 2,
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
        superSortEnabled: false, 
    },
    knowledgeBases: {},
};
