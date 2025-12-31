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
        this.status = 'idle'; // idle, running, paused
        this.approvalRequired = false;
        this.pendingToolCall = null;
    }

    async setContext(chid, bookName) {
        this.currentChid = chid;
        this.currentBookName = bookName;
        
        if (bookName && bookName !== 'new') {
            try {
                // Use return_full: true to get content for ContextManager (RAG)
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

    stop() {
        this.status = 'idle';
    }

    async resumeWithApproval(approved, feedback, onStreamUpdate, onPreviewUpdate, onApprovalRequest) {
        if (this.status !== 'paused' || !this.pendingToolCall) return;

        if (approved) {
            this.status = 'running';
            await this.executePendingTool(onStreamUpdate, onPreviewUpdate);
            this.pendingToolCall = null;
            await this.runTaskLoop(onStreamUpdate, onPreviewUpdate, onApprovalRequest);
        } else {
            this.status = 'running';
            this.pendingToolCall = null;
            // Add feedback as user message to guide correction
            this.history.push({ 
                role: 'user', 
                content: `[Tool Execution Denied] User Feedback: ${feedback || "No reason provided."}` 
            });
            await this.runTaskLoop(onStreamUpdate, onPreviewUpdate, onApprovalRequest);
        }
    }

    async buildSystemPrompt() {
        const toolDefs = getToolDefinitions();
        
        // 1. Role & Objective
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

        // Dynamic Context Injection (Rules & World Info)
        const contextText = this.getLastUserMessage() || "";
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

        // Environment Details Injection
        let envDetails = `\n<environment_details>\n`;
        envDetails += `# Current Time\n${new Date().toLocaleString()}\n\n`;
        
        if (this.currentChid !== undefined && this.currentChid !== 'new') {
            try {
                const charData = await tools.read_character_card({ chid: this.currentChid });
                const char = JSON.parse(charData);
                envDetails += `# Current Character\n`;
                envDetails += `Name: ${char.name}\n`;
                envDetails += `Description Length: ${char.description?.length || 0}\n`;
                envDetails += `First Message Length: ${char.first_mes?.length || 0}\n`;
                envDetails += `Description Snippet: ${char.description?.substring(0, 200).replace(/\n/g, ' ')}...\n\n`;
            } catch (e) {
                envDetails += `# Current Character\nError reading character: ${e.message}\n\n`;
            }
        }
        
        if (this.currentBookName && this.currentBookName !== 'new') {
             try {
                // Get the index for the system prompt
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

        // 2. Tools
        prompt += `\n# Tools\n\n`;
        toolDefs.forEach(tool => {
            prompt += `## ${tool.name}\n`;
            prompt += `Description: ${tool.description}\n`;
            prompt += `Parameters:\n${JSON.stringify(tool.parameters, null, 2)}\n\n`;
        });

        // 3. Tool Use Formatting
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

- **Think First**: Before using any tool, you MUST output a \`<thinking>\` block explaining your plan and reasoning.
- **One Tool Per Turn**: You can only use ONE tool per message. Wait for the result before proceeding.
- **Verify Results**: Always check the [Tool Result] to ensure success. If a tool fails, analyze the error and try again.
- **Detailed Writing**: When writing content (Description, First Message, World Info), be creative and detailed.
   - World Info entries: > 300 words.
   - First Message: > 1500 words, including environment, psychology, and action.
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

    async handleUserMessage(message, onStreamUpdate, onPreviewUpdate, onApprovalRequest) {
        // Initialize task state if it's the first message or explicitly requested
        if (this.history.length === 0) {
            this.taskState.init(message);
        }
        
        this.history.push({ role: 'user', content: message });
        this.status = 'running';
        await this.runTaskLoop(onStreamUpdate, onPreviewUpdate, onApprovalRequest);
    }

    async runTaskLoop(onStreamUpdate, onPreviewUpdate, onApprovalRequest) {
        let maxTurns = 20; // Safety limit
        let currentTurn = 0;

        while (this.status === 'running' && currentTurn < maxTurns) {
            currentTurn++;
            
            // 0. Check Memory/Context
            const config = getApiConfig('executor'); 
            const currentTokens = this.contextManager.estimateTokens(JSON.stringify(this.history));
            
            if (this.memorySystem.shouldSummarize(this.history, currentTokens, config.maxTokens)) {
                onStreamUpdate("Context limit approaching. Summarizing memory...", 'system');
                const summary = await this.memorySystem.summarize(this.history, this.taskState);
                if (summary) {
                    this.taskState.updateSummary(summary);
                    // Optional: Compress history here. For now, we just rely on the summary being injected.
                    // A simple compression strategy: Keep the last 5 messages, and replace the rest with a system note.
                    if (this.history.length > 5) {
                        const lastMessages = this.history.slice(-5);
                        this.history = [
                            { role: 'system', content: `[History Compressed] Previous conversation has been summarized in the "Memory & Task State" section. Resuming from recent messages.` },
                            ...lastMessages
                        ];
                    }
                }
            }

            // 1. Build System Prompt (Dynamic)
            const systemPrompt = await this.buildSystemPrompt();
            
            // 2. Build Messages
            const messages = this.contextManager.buildMessages(
                systemPrompt, 
                this.history,
                config.maxTokens
            );

            // 3. Call AI
            let responseContent;
            let fullStreamedContent = "";
            try {
                onStreamUpdate("Thinking...", 'system');
                responseContent = await callAi('executor', messages, {}, (chunk) => {
                    onStreamUpdate(chunk, 'stream-assistant');
                    fullStreamedContent += chunk;
                    
                    // Try to parse partial tool call for real-time preview
                    if (onPreviewUpdate) {
                        const partialTool = this.parsePartialToolCall(fullStreamedContent);
                        if (partialTool) {
                            onPreviewUpdate(partialTool.name, partialTool.arguments, true); // true = isPartial
                        }
                    }
                });
            } catch (error) {
                onStreamUpdate(`[Error] ${error.message}`, 'system');
                this.status = 'idle'; // Stop on API error
                return;
            }

            if (this.status !== 'running') return; // Check if stopped during await

            // 4. Process Response
            
            // Check for truncation (Auto-Continue)
            const lastChar = responseContent.trim().slice(-1);
            const isTruncated = !['.', '!', '?', '"', "'", '}', ']', '>', '*'].includes(lastChar) && responseContent.length > 100;

            if (isTruncated && currentTurn < maxTurns) {
                console.log("检测到回复截断，正在自动继续...");
                try {
                    // Append a continue message
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
            
            // Clean up content for UI display
            let cleanContent = responseContent
                .replace(/<thinking(?:\s+[^>]*)?>[\s\S]*?<\/thinking>/gi, '')
                .replace(/<\/thinking>/gi, ''); // Remove residual tags

            const toolNames = Object.keys(tools);
            const toolRegex = new RegExp(`<(${toolNames.join('|')})(?:\\s+[^>]*)?>[\\s\\S]*?<\\/\\1>`, 'gi');
            cleanContent = cleanContent.replace(toolRegex, '').trim();
            
            // Update the UI with the final clean content (replacing the raw stream)
            if (cleanContent) {
               onStreamUpdate(cleanContent, 'assistant');
            }

            // 5. Parse Tool Call
            const toolCall = this.parseToolCall(responseContent);
            
            if (toolCall) {
                // Check for duplicate tool calls to prevent loops
                if (this.isDuplicateToolCall(toolCall)) {
                    const warningMsg = `[System Warning] You have just executed this exact tool call (${toolCall.name}). Do not repeat the same action immediately. If you need to check the result again, look at the conversation history. If the previous result was unsatisfactory, try a different approach.`;
                    this.history.push({ role: 'user', content: warningMsg });
                    continue;
                }

                // Inject Context if missing
                if (toolCall.name === 'update_character_card' || toolCall.name === 'read_character_card' || toolCall.name === 'edit_character_text' || toolCall.name === 'manage_first_message') {
                    if (toolCall.arguments.chid === undefined && this.currentChid !== undefined) {
                        toolCall.arguments.chid = parseInt(this.currentChid);
                    }
                }
                if (toolCall.name === 'write_world_info_entry' || toolCall.name === 'read_world_info') {
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
                    return; // Exit loop, wait for resumeWithApproval
                } else {
                    await this.executePendingTool(onStreamUpdate, onPreviewUpdate);
                    this.pendingToolCall = null;
                }
            } else {
                this.status = 'idle';
            }
        }
    }

    async executePendingTool(onStreamUpdate, onPreviewUpdate) {
        const toolCall = this.pendingToolCall;
        if (!toolCall) return;

        onStreamUpdate(`Executing: ${toolCall.name}`, 'system');
        
        let result;
        try {
            if (tools[toolCall.name]) {
                result = await tools[toolCall.name](toolCall.arguments);
                
                if (toolCall.name === 'create_character' && result.includes('ID:')) {
                    const match = result.match(/ID:\s*(\d+)/);
                    if (match) {
                        this.currentChid = parseInt(match[1]);
                    }
                }
            } else {
                result = `Error: Tool '${toolCall.name}' not found.`;
            }
        } catch (error) {
            result = `Error executing tool '${toolCall.name}': ${error.message}`;
        }

        const toolResultMsg = `[Tool Result for ${toolCall.name}]\n${result}`;
        this.history.push({ role: 'user', content: toolResultMsg });
        
        if (onPreviewUpdate && !result.startsWith('Error')) {
            onPreviewUpdate(toolCall.name, toolCall.arguments);
        }
    }

    isDuplicateToolCall(toolCall) {
        if (this.history.length < 3) return false;
        
        // History structure:
        // ...
        // Assistant: <tool>A</tool> (index -3)
        // User: [Tool Result A] (index -2)
        // Assistant: <tool>A</tool> (index -1, current)
        
        const prevAssistantMsg = this.history[this.history.length - 3];
        const prevUserMsg = this.history[this.history.length - 2];
        
        if (prevAssistantMsg.role === 'assistant' && prevUserMsg.role === 'user' && prevUserMsg.content.startsWith('[Tool Result')) {
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
            // Look for the opening tag
            const openTagRegex = new RegExp(`<${name}>`);
            const openMatch = content.match(openTagRegex);
            
            if (openMatch) {
                // We found a tool start. Now try to extract params, even if incomplete.
                const startIndex = openMatch.index + openMatch[0].length;
                const toolContent = content.slice(startIndex);
                
                const args = {};
                // Match complete tags or tags that are still open (at the end)
                // <param>value...</param> OR <param>value...
                const paramRegex = /<(\w+)>([\s\S]*?)(?:<\/\1>|$)/g;
                
                let paramMatch;
                while ((paramMatch = paramRegex.exec(toolContent)) !== null) {
                    const paramName = paramMatch[1];
                    let paramValue = paramMatch[2];
                    
                    // Don't try to JSON parse partial content here, leave it as string
                    // The UI handler will deal with partial JSON
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
