import { callAi, getApiConfig } from "./api.js";

export class MemorySystem {
    constructor() {
        this.summarizePrompt = `
The current conversation context is growing large. Your task is to create a comprehensive, structured summary of the character/world generation process so far.
This summary will be used as the "Memory" for the next steps, so it must be detailed enough to prevent information loss.

Please summarize the following:
1. **Core Identity**: Name, Age, Gender, Role, etc.
2. **Personality & Traits**: Key personality keywords, behavioral quirks, speech patterns.
3. **Appearance**: Physical description, clothing, accessories.
4. **Background & Lore**: Backstory, world setting, important relationships.
5. **Current Progress**: What has been completed, what is currently being worked on, and what is left to do.
6. **User Preferences**: Any specific constraints or requests made by the user (e.g., "Make her tsundere", "Don't use modern technology").

Format your response as a structured Markdown block.
`;
    }

    async summarize(history, taskState) {
        const config = getApiConfig('executor');

        const contextMsg = `
[System Note]: The following is the current Task State. Use this to inform your summary.
${taskState.getPromptContext()}
`;

        const messages = [
            { role: 'system', content: this.summarizePrompt },
            ...history.slice(-10), 
            { role: 'user', content: `Please summarize the session based on the history above. ${contextMsg}` }
        ];

        try {
            const response = await callAi('executor', messages, {
                max_tokens: 2000, 
                temperature: 0.5 
            });
            
            return response;
        } catch (error) {
            console.error("Failed to generate summary:", error);
            return null;
        }
    }
    
    shouldSummarize(history, tokenCount, maxTokens) {
        const tokenUsageRatio = tokenCount / maxTokens;
        if (tokenUsageRatio > 0.7) return true;
        if (history.length > 15) return true;
        return false;
    }
}
