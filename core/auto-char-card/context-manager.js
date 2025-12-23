export class ContextManager {
    constructor() {
        this.keepToolOutputTurns = 3; 
        this.tokenLimit = 12000; 
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
