export class ContextManager {
    constructor() {
        this.keepToolOutputTurns = 5; 
        this.tokenLimit = 100000; 
        this.rules = [];
        this.worldInfo = [];
        this.activeWorldInfoCache = new Map();
        this.cacheDuration = 3; 
    }

    addRule(rule) {
        this.rules.push({
            id: rule.id || Date.now().toString(),
            keyword: rule.keyword || null, 
            content: rule.content,
            enabled: rule.enabled !== undefined ? rule.enabled : true
        });
    }

    setWorldInfo(entries) {
        this.worldInfo = entries.map(entry => {
            let keys = [];
            if (Array.isArray(entry.key)) {
                keys = entry.key;
            } else if (typeof entry.key === 'string') {
                keys = entry.key.split(',').map(k => k.trim()).filter(k => k);
            }
            
            return {
                id: entry.uid,
                keys: keys,
                content: entry.content,
                enabled: entry.enabled !== false
            };
        });
    }

    getRelevantContext(contextText) {
        const relevantRules = this.rules.filter(rule => {
            if (!rule.enabled) return false;
            if (!rule.keyword) return true; 
            return contextText.includes(rule.keyword);
        });

        const currentMatches = this.worldInfo.filter(entry => {
            if (!entry.enabled) return false;
            if (!entry.keys || entry.keys.length === 0) return false;
            return entry.keys.some(key => contextText.includes(key));
        });

        for (const [uid, data] of this.activeWorldInfoCache) {
            data.turnsLeft--;
            if (data.turnsLeft <= 0) {
                this.activeWorldInfoCache.delete(uid);
            }
        }

        currentMatches.forEach(entry => {
            this.activeWorldInfoCache.set(entry.id, { turnsLeft: this.cacheDuration });
        });

        const allRelevantUIDs = new Set([...currentMatches.map(e => e.id), ...this.activeWorldInfoCache.keys()]);
        
        const relevantWorldInfo = this.worldInfo.filter(entry => allRelevantUIDs.has(entry.id));

        return {
            rules: relevantRules,
            worldInfo: relevantWorldInfo
        };
    }

    estimateTokens(text) {
        return Math.ceil((text || '').length / 3.5);
    }

    buildMessages(systemPrompt, history, maxTokens) {
        const limit = maxTokens || this.tokenLimit;
        const systemTokens = this.estimateTokens(systemPrompt);
        let availableTokens = limit - systemTokens - 1000; 

        if (availableTokens < 0) availableTokens = 1000; 

        const optimizedHistory = this.optimizeToolOutputs(history);

        const finalMessages = [];
        let currentTokens = 0;

        for (let i = optimizedHistory.length - 1; i >= 0; i--) {
            const msg = optimizedHistory[i];
            const msgTokens = this.estimateTokens(msg.content);

            if (currentTokens + msgTokens > availableTokens) {
                finalMessages.unshift({ role: 'system', content: "[Earlier history truncated to save tokens]" });
                break;
            }

            finalMessages.unshift(msg);
            currentTokens += msgTokens;
        }

        return [
            { role: 'system', content: systemPrompt },
            ...finalMessages
        ];
    }

    optimizeToolOutputs(history) {
        let toolOutputCount = 0;
        const reversedHistory = [...history].reverse();
        
        const processedReversed = reversedHistory.map((msg) => {
            if (msg.role === 'user' && msg.content.startsWith('[Tool Result')) {
                toolOutputCount++;
                
                if (toolOutputCount > this.keepToolOutputTurns) {
                    const firstLine = msg.content.split('\n')[0];
                    return {
                        role: msg.role,
                        content: `${firstLine}\n[Content hidden to save tokens. The tool was executed successfully.]`
                    };
                }
            }
            return msg;
        });

        return processedReversed.reverse();
    }
}
