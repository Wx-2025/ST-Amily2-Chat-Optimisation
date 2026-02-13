import { callAi, getApiConfig } from "./api.js";
import { tools, getToolDefinitions } from "./tools.js";
import { ContextManager } from "./context-manager.js";
import { TaskState } from "./task-state.js";
import { MemorySystem } from "./memory-system.js";

export class AgentManager {
    constructor() {
        this.history = []; 
        this.contextManager = new ContextManager();
        this.taskState = new TaskState();
        this.memorySystem = new MemorySystem();
        this.currentChid = undefined;
        this.currentBookName = undefined;
        this.status = 'idle';
        this.approvalRequired = false;
        this.pendingToolCall = null;
    }

    async setContext(chid, bookName) {
        this.currentChid = chid;
        this.currentBookName = bookName;
        
        if (bookName && bookName !== 'new') {
            try {
                const bookData = await tools.read_world_info({ book_name: bookName, return_full: true });
                const entries = JSON.parse(bookData);
                this.contextManager.setWorldInfo(entries);
            } catch (e) {
                console.error("Failed to load world info for context:", e);
            }
        }
    }

    setApprovalRequired(required) {
        this.approvalRequired = required;
    }

    updatePendingToolArgs(newArgs) {
        if (this.pendingToolCall) {
            this.pendingToolCall.arguments = { ...this.pendingToolCall.arguments, ...newArgs };
            console.log("[AgentManager] Pending tool args updated:", this.pendingToolCall.arguments);
        }
    }

    stop() {
        this.status = 'idle';
    }

    async resumeWithApproval(approved, feedback, onStreamUpdate, onPreviewUpdate, onApprovalRequest, onContextUpdate, onPromptGenerated) {
        if (this.status !== 'paused' || !this.pendingToolCall) return;

        if (approved) {
            this.status = 'running';
            await this.executePendingTool(onStreamUpdate, onPreviewUpdate, onContextUpdate);
            this.pendingToolCall = null;
            await this.runTaskLoop(onStreamUpdate, onPreviewUpdate, onApprovalRequest, onContextUpdate, onPromptGenerated);
        } else {
            this.status = 'running';
            this.pendingToolCall = null;
            this.history.push({ 
                role: 'user', 
                content: `[工具执行被拒绝] 用户反馈: ${feedback || "未提供原因。"}` 
            });
            await this.runTaskLoop(onStreamUpdate, onPreviewUpdate, onApprovalRequest, onContextUpdate, onPromptGenerated);
        }
    }

    async buildSystemPrompt() {
        const toolDefs = getToolDefinitions();
        
        let prompt = `You are an expert Character Card Designer and World Builder.
You accomplish a given task iteratively, breaking it down into clear steps and working through them methodically.

IMPORTANT: You MUST speak in Chinese (Simplified) for all your responses and reasoning.

**Core Capabilities**:
- You can create and modify **Single Character Cards**.
- You can create and modify **Multi-Character World Cards** (Group Cards). Do not assume the user only wants a single character.
- You can manage **World Info (Lorebooks)**.

**Workflow**:
1. **Analyze & Explore First**: The World Book Index is provided in the context below. Review it to see what entries exist. If you need the *content* of a specific entry, use \`read_world_entry\` with its UID. Do not use \`read_world_info\` unless you need to refresh the index.
2. **Plan & Execute**: Based on the read data, formulate a plan and execute it step-by-step.
3. **Tool Usage**: Use one tool per turn. Always explain your reasoning in \`<thinking>\` tags before using a tool.
4. **Completion**: When finished, provide a concise summary.

# Memory & Task State
${this.taskState.getPromptContext()}

# Current Context
`;

        if (this.currentChid === 'new') {
            prompt += `- **Status**: Creating a NEW character.\n`;
            prompt += `- **Action Required**: Use \`create_character\` first to get a Character ID.\n`;
        } else if (this.currentChid !== undefined) {
            prompt += `- **Character ID**: ${this.currentChid}\n`;
        }
        
        if (this.currentBookName) {
            prompt += `- **World Info Book**: ${this.currentBookName}\n`;
        }

        const recentHistory = this.history.slice(-3).map(m => m.content).join('\n');
        const contextText = (recentHistory + "\n" + (this.getLastUserMessage() || "")).trim();
        
        const { rules, worldInfo } = this.contextManager.getRelevantContext(contextText);
        
        if (rules.length > 0) {
            prompt += `\n# Style Guides & Rules\n`;
            rules.forEach(rule => {
                prompt += `- ${rule.content}\n`;
            });
        }

        if (worldInfo.length > 0) {
            prompt += `\n# World Info Context\n`;
            worldInfo.forEach(entry => {
                prompt += `## Entry: ${entry.keys.join(', ')}\n${entry.content}\n\n`;
            });
        }

        let envDetails = `\n<environment_details>\n`;
        envDetails += `# Current Time\n${new Date().toLocaleString()}\n\n`;
        
        if (this.currentChid !== undefined && this.currentChid !== 'new') {
            try {
                const charData = await tools.read_character_card({ chid: this.currentChid });
                const response = JSON.parse(charData);
                
                if (response.status === 'success' && response.data) {
                    const char = response.data;
                    envDetails += `# Current Character\n`;
                    envDetails += `Name: ${char.name}\n`;
                    envDetails += `Description Length: ${char.description?.length || 0}\n`;
                    envDetails += `First Message Length: ${char.first_mes?.length || 0}\n`;
                    envDetails += `Description Snippet: ${char.description?.substring(0, 200).replace(/\n/g, ' ')}...\n\n`;
                } else {
                    envDetails += `# Current Character\nError reading character: ${response.message || 'Unknown error'}\n\n`;
                }
            } catch (e) {
                envDetails += `# Current Character\nError reading character: ${e.message}\n\n`;
            }
        }
        
        if (this.currentBookName && this.currentBookName !== 'new') {
             try {
                const bookData = await tools.read_world_info({ book_name: this.currentBookName, return_full: false });
                const result = JSON.parse(bookData);
                envDetails += `# Current World Book Index\n`;
                envDetails += `Name: ${this.currentBookName}\n`;
                envDetails += `Total Entries: ${result.total_entries}\n`;
                envDetails += `Entries List (UID | Name | Keys):\n`;
                
                if (result.entries && result.entries.length > 0) {
                    result.entries.forEach(entry => {
                        const keys = Array.isArray(entry.keys) ? entry.keys.join(', ') : entry.keys;
                        const name = entry.comment || keys || "Unnamed";
                        envDetails += `- [${entry.uid}] ${name} (Keys: ${keys})\n`;
                    });
                } else {
                    envDetails += `(No entries found)\n`;
                }
                envDetails += `\n`;
            } catch (e) {
                envDetails += `# Current World Book\nError reading world book: ${e.message}\n\n`;
            }
        }
        envDetails += `</environment_details>\n`;
        prompt += envDetails;

        prompt += `\n# Tools\n\n`;
        toolDefs.forEach(tool => {
            prompt += `## ${tool.name}\n`;
            prompt += `Description: ${tool.description}\n`;
            prompt += `Parameters:\n${JSON.stringify(tool.parameters, null, 2)}\n\n`;
        });

        prompt += `
# Tool Use Formatting

Tool use is formatted using XML-style tags. The tool name is enclosed in opening and closing tags, and each parameter is similarly enclosed within its own set of tags.

<tool_name>
<parameter1_name>value1</parameter1_name>
<parameter2_name>value2</parameter2_name>
...
</tool_name>

**Important**: For complex parameters (arrays or objects), write the **JSON string** directly inside the tag.

Example:
<write_world_info_entry>
<book_name>MyWorld</book_name>
<entries>[{"key": "Entry1", "content": "..."}]</entries>
</write_world_info_entry>

# Rules

- **Plan First**: Before using any tool, you MUST output a \`<plan>\` block listing the steps you intend to take.
- **Think**: After planning, output a \`<thinking>\` block explaining your reasoning for the immediate next steps.
- **One Tool Per Turn**: You can only use ONE tool per message. Wait for the result before proceeding.
- **Verify Results**: Always check the [Tool Result] to ensure success. If a tool fails, analyze the error and try again.
- **Detailed Writing**: When writing content (Description, First Message, World Info), be creative and detailed.
   - World Info entries: > 300 words.
   - First Message: > 1500 words, including environment, psychology, and action.
- **Tool Selection**:
   - **Use \`edit_character_text\`** for small modifications to existing large text fields (Description, First Message, etc.). This is more precise and saves tokens.
   - **Use \`edit_world_info_entry\`** for small modifications to existing World Info entries.
   - **Use \`update_character_card\`** only when populating empty fields or rewriting the entire content of a field.
   - **Use \`write_world_info_entry\`** only when creating new entries or rewriting the entire content of an entry.
- **Do not ask for more information than necessary**: Use the tools provided to accomplish the user's request efficiently and effectively.
- **Completion**: When the task is done, provide a final summary to the user.
`;
        return prompt;
    }

    getLastUserMessage() {
        for (let i = this.history.length - 1; i >= 0; i--) {
            if (this.history[i].role === 'user') {
                return this.history[i].content;
            }
        }
        return null;
    }

    async handleUserMessage(message, onStreamUpdate, onPreviewUpdate, onApprovalRequest, onContextUpdate, onPromptGenerated) {
        if (this.history.length === 0) {
            this.taskState.init(message);
        }
        
        this.history.push({ role: 'user', content: message });
        this.status = 'running';
        await this.runTaskLoop(onStreamUpdate, onPreviewUpdate, onApprovalRequest, onContextUpdate, onPromptGenerated);
    }

    async runTaskLoop(onStreamUpdate, onPreviewUpdate, onApprovalRequest, onContextUpdate, onPromptGenerated) {
        let maxTurns = 20;
        let currentTurn = 0;

        while (this.status === 'running' && currentTurn < maxTurns) {
            currentTurn++;

            const config = getApiConfig('executor'); 
            const currentTokens = this.contextManager.estimateTokens(JSON.stringify(this.history));
            
            if (this.memorySystem.shouldSummarize(this.history, currentTokens, config.maxTokens)) {
                onStreamUpdate("上下文即将达到上限，正在总结记忆...", 'system');
                const summary = await this.memorySystem.summarize(this.history, this.taskState);
                if (summary) {
                    this.taskState.updateSummary(summary);
                    if (this.history.length > 5) {
                        const lastMessages = this.history.slice(-5);
                        this.history = [
                            { role: 'system', content: `[历史记录已压缩] 之前的对话已总结在“记忆与任务状态”部分。从最近的消息继续。` },
                            ...lastMessages
                        ];
                    }
                }
            }

            const systemPrompt = await this.buildSystemPrompt();

            const messages = this.contextManager.buildMessages(
                systemPrompt, 
                this.history,
                config.maxTokens
            );

            if (onPromptGenerated) {
                onPromptGenerated(messages);
            }

            let responseContent;
            let fullStreamedContent = "";
            try {
                onStreamUpdate("思考中...", 'system');
                responseContent = await callAi('executor', messages, {}, (chunk) => {
                    onStreamUpdate(chunk, 'stream-assistant');
                    fullStreamedContent += chunk;

                    if (onPreviewUpdate) {
                        const partialTool = this.parsePartialToolCall(fullStreamedContent);
                        if (partialTool) {
                            onPreviewUpdate(partialTool.name, partialTool.arguments, true); 
                        }
                    }
                });
            } catch (error) {
                onStreamUpdate(`[错误] ${error.message}`, 'system');
                this.status = 'idle';
                return;
            }

            if (this.status !== 'running') return;

            const lastChar = responseContent.trim().slice(-1);
            const isTruncated = !['.', '!', '?', '"', "'", '}', ']', '>', '*'].includes(lastChar) && responseContent.length > 100;

            if (isTruncated && currentTurn < maxTurns) {
                console.log("检测到回复截断，正在自动继续...");
                try {
                    const continueMsg = { role: 'user', content: "Continue" };
                    const continueMessages = [...messages, { role: 'assistant', content: responseContent }, continueMsg];
                    
                    const continuation = await callAi('executor', continueMessages, {}, (chunk) => {
                        onStreamUpdate(chunk, 'stream-assistant');
                    });
                    
                    responseContent += continuation;
                    console.log("自动合并接续内容完成");
                } catch (e) {
                    console.warn("Auto-continue failed:", e);
                }
            }

            this.history.push({ role: 'assistant', content: responseContent });
            
            const thinkingMatch = responseContent.match(/<thinking>([\s\S]*?)<\/thinking>/);
            if (thinkingMatch) {
                onStreamUpdate(thinkingMatch[1].trim(), 'thought');
            }

            let cleanContent = responseContent
                .replace(/<thinking(?:\s+[^>]*)?>[\s\S]*?<\/thinking>/gi, '')
                .replace(/<\/thinking>/gi, '');

            const toolNames = Object.keys(tools);
            const toolRegex = new RegExp(`<(${toolNames.join('|')})(?:\\s+[^>]*)?>[\\s\\S]*?<\\/\\1>`, 'gi');
            cleanContent = cleanContent.replace(toolRegex, '').trim();
            
            if (cleanContent) {
               onStreamUpdate(cleanContent, 'assistant');
            }

            const toolCall = this.parseToolCall(responseContent);
            
            if (toolCall) {
                if (this.isDuplicateToolCall(toolCall)) {
                    const warningMsg = `[系统警告] 你刚刚执行了完全相同的工具调用 (${toolCall.name})。请勿立即重复相同的操作。如果需要再次检查结果，请查看对话历史。如果之前的结果不满意，请尝试不同的方法。`;
                    this.history.push({ role: 'user', content: warningMsg });
                    continue;
                }

                if (toolCall.name === 'update_character_card' || toolCall.name === 'read_character_card' || toolCall.name === 'edit_character_text' || toolCall.name === 'manage_first_message') {
                    if (toolCall.arguments.chid === undefined && this.currentChid !== undefined) {
                        toolCall.arguments.chid = parseInt(this.currentChid);
                    }
                }
                if (toolCall.name === 'write_world_info_entry' || toolCall.name === 'read_world_info' || toolCall.name === 'edit_world_info_entry') {
                    if (!toolCall.arguments.book_name && this.currentBookName) {
                        toolCall.arguments.book_name = this.currentBookName;
                    }
                }

                this.pendingToolCall = toolCall;

                if (this.approvalRequired) {
                    this.status = 'paused';
                    if (onApprovalRequest) {
                        onApprovalRequest(toolCall.name, toolCall.arguments);
                    }
                    return; 
                } else {
                    await this.executePendingTool(onStreamUpdate, onPreviewUpdate, onContextUpdate);
                    this.pendingToolCall = null;
                }
            } else {
                this.status = 'idle';
            }
        }
    }

    async executePendingTool(onStreamUpdate, onPreviewUpdate, onContextUpdate) {
        const toolCall = this.pendingToolCall;
        if (!toolCall) return;

        onStreamUpdate(`正在执行: ${toolCall.name}`, 'system');
        
        let result;
        try {
            if (tools[toolCall.name]) {
                result = await tools[toolCall.name](toolCall.arguments);

                try {
                    const jsonResult = JSON.parse(result);
                    
                    if (toolCall.name === 'create_character' && jsonResult.status === 'success' && jsonResult.data && jsonResult.data.id) {
                        this.currentChid = parseInt(jsonResult.data.id);
                        if (onContextUpdate) onContextUpdate('char', this.currentChid);
                    }
                    
                    if (toolCall.name === 'create_world_book' && jsonResult.status === 'success') {
                        this.currentBookName = toolCall.arguments.book_name;
                        if (onContextUpdate) onContextUpdate('world', this.currentBookName);
                    }

                    if (jsonResult._action === 'update_task_state' && jsonResult._updates) {
                        if (jsonResult._updates.style_reference) {
                            this.taskState.setStyle(jsonResult._updates.style_reference);
                        }
                    }

                    if (jsonResult._action === 'stop_and_wait') {
                        this.status = 'idle';
                    }
                } catch (e) {
                    if (toolCall.name === 'create_character' && result.includes('ID:')) {
                        const match = result.match(/ID:\s*(\d+)/);
                        if (match) {
                            this.currentChid = parseInt(match[1]);
                            if (onContextUpdate) onContextUpdate('char', this.currentChid);
                        }
                    }
                }
            } else {
                result = JSON.stringify({
                    status: "error",
                    code: "TOOL_NOT_FOUND",
                    message: `错误: 未找到工具 '${toolCall.name}'。`
                });
            }
        } catch (error) {
            result = JSON.stringify({
                status: "error",
                code: "EXECUTION_ERROR",
                message: `执行工具 '${toolCall.name}' 时出错: ${error.message}`
            });
        }

        const toolResultMsg = `[工具 '${toolCall.name}' 的执行结果]\n${result}`;
        this.history.push({ role: 'user', content: toolResultMsg });

        let isError = false;
        try {
            const jsonResult = JSON.parse(result);
            if (jsonResult.status === 'error') isError = true;
        } catch (e) {
            if (result.startsWith('Error')) isError = true;
        }

        if (onPreviewUpdate && !isError) {
            onPreviewUpdate(toolCall.name, toolCall.arguments, false, true);
        }
    }

    isDuplicateToolCall(toolCall) {
        if (this.history.length < 3) return false;

        
        const prevAssistantMsg = this.history[this.history.length - 3];
        const prevUserMsg = this.history[this.history.length - 2];
        
        if (prevAssistantMsg.role === 'assistant' && prevUserMsg.role === 'user' && prevUserMsg.content.startsWith('[工具')) {
            const prevToolCall = this.parseToolCall(prevAssistantMsg.content);
            if (prevToolCall && 
                prevToolCall.name === toolCall.name && 
                JSON.stringify(prevToolCall.arguments) === JSON.stringify(toolCall.arguments)) {
                return true;
            }
        }
        return false;
    }

    parseToolCall(content) {
        const toolNames = Object.keys(tools);
        for (const name of toolNames) {
            const regex = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`);
            const match = content.match(regex);
            
            if (match) {
                const argsContent = match[1];
                const args = {};
                
                const paramRegex = /<(\w+)>([\s\S]*?)<\/\1>/g;
                let paramMatch;
                while ((paramMatch = paramRegex.exec(argsContent)) !== null) {
                    const paramName = paramMatch[1];
                    let paramValue = paramMatch[2];
                    
                    if (paramValue.trim().startsWith('{') || paramValue.trim().startsWith('[')) {
                        try {
                            paramValue = JSON.parse(paramValue);
                        } catch (e) {
                        }
                    }
                    args[paramName] = paramValue;
                }
                
                return { name, arguments: args };
            }
        }
        return null;
    }

    parsePartialToolCall(content) {
        const toolNames = Object.keys(tools);
        for (const name of toolNames) {
            const openTagRegex = new RegExp(`<${name}>`);
            const openMatch = content.match(openTagRegex);
            
            if (openMatch) {
                const startIndex = openMatch.index + openMatch[0].length;
                const toolContent = content.slice(startIndex);
                
                const args = {};

                const paramRegex = /<(\w+)>([\s\S]*?)(?:<\/\1>|$)/g;
                
                let paramMatch;
                while ((paramMatch = paramRegex.exec(toolContent)) !== null) {
                    const paramName = paramMatch[1];
                    let paramValue = paramMatch[2];

                    args[paramName] = paramValue;
                }
                
                return { name, arguments: args };
            }
        }
        return null;
    }
    
    clearHistory() {
        this.history = [];
    }
}
