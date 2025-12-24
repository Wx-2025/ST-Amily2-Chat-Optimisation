import { callAi, getApiConfig } from "./api.js";
import { tools, getToolDefinitions } from "./tools.js";
import { ContextManager } from "./context-manager.js";

export class AgentManager {
    constructor() {
        this.history = []; 
        this.executorHistory = [];
        this.reviewerHistory = [];
        this.executorSystemPrompt = this.buildExecutorSystemPrompt();
        this.reviewerSystemPrompt = this.buildReviewerSystemPrompt();
        this.contextManager = new ContextManager();
        this.currentChid = undefined;
        this.currentBookName = undefined;
    }

    setContext(chid, bookName) {
        this.currentChid = chid;
        this.currentBookName = bookName;
        this.executorSystemPrompt = this.buildExecutorSystemPrompt();
    }

    buildReviewerSystemPrompt() {
        const toolDefs = getToolDefinitions();
        let prompt = `你是一个经验丰富的角色卡设计师和辅导员（Reviewer）。你的搭档是一个执行力强且富有创造力的 AI 助手（Executor）。
你的目标是根据用户的需求，设计出高质量的角色卡和世界书方案，并指导 Executor 一步步实现。

Executor 拥有以下工具（你不能直接使用，但需要知道它能做什么）：
`;
        toolDefs.forEach(tool => {
            prompt += `- ${tool.name}: ${tool.description}\n`;
        });

        prompt += `
### 世界书高级设置指南 (World Info Settings)
- **constant (蓝灯)**: 如果为 true，该条目将始终被激活并包含在上下文中，忽略关键词触发。
- **position (插入位置)**: 决定条目内容在 Prompt 中的位置。
  - \`before/after_character_definition\`: 角色定义前后。
  - \`before/after_author_note\`: 作者注释前后。
  - \`at_depth_as_system\`: 在指定深度作为系统消息插入（推荐）。
- **depth (插入深度)**: 仅当 position 为 \`at_depth_as_system\` 时有效。表示条目距离最新消息的距离（例如 0 为最新，4 为倒数第 4 条消息后）。
- **scanDepth (扫描深度)**: 系统扫描关键词的消息范围。例如 2 表示只扫描最近 2 条消息。
- **exclude_recursion**: 如果为 true，此条目的内容不会触发其他条目。
- **prevent_recursion**: 如果为 true，其他条目的内容不会触发此条目。

你的工作流程：
1. 分析用户需求。
2. 制定详细的实施计划（大纲）。
3. 将计划拆解为 Executor 可以执行的**指导性指令**。
4. 审查 Executor 的执行结果，提出修改意见。

**关键原则：**
- **只给方案，不给成品**：你负责提供创意方向、关键设定点和风格指导，让 Executor 去进行具体的文本创作和扩写。不要直接把完整的角色描述或世界书内容写出来让 Executor 照抄。
- **示例**：
  - ❌ 错误：“请写入以下描述：她有一头金发，性格傲娇...”
  - ✅ 正确：“请为角色撰写一段详细的外貌和性格描述。外貌上要突出她的金发和贵族气质，性格上要体现出‘傲娇’的特点，即外表冷漠但内心渴望被关怀。请发挥你的文采。”

交互规则：
- 当你需要 Executor 执行操作时，请在回复的最后一行使用标签：<instruction>你的指令</instruction>
- **重要**：<instruction> 标签内必须是**自然语言指令**。**严禁**直接输出 JSON 代码块作为指令。
- **单步原则**：每次指令**只能包含一个**具体的任务（例如：只创建一个世界书条目，或只更新角色描述）。严禁一次性下达多个任务。
- **字数强制**：在指令中必须明确要求 Executor 进行深度扩写。
  - 世界书条目：要求**不低于 300 字**。
  - 角色开场白：要求**不低于 1500 字**。
- 当你认为任务已完成或需要用户反馈时，直接回复用户即可，不要包含 <instruction> 标签。
`;
        return prompt;
    }

    buildExecutorSystemPrompt() {
        const toolDefs = getToolDefinitions();
        let contextInfo = "";
        
        if (this.currentChid === 'new') {
            contextInfo += `**注意：用户希望创建一个新角色。**\n请首先使用 \`create_character\` 工具创建角色。创建成功后，你将获得新的角色 ID，请使用该 ID 进行后续操作（如 \`update_character_card\`）。\n`;
        } else if (this.currentChid !== undefined) {
            contextInfo += `当前操作的角色ID: ${this.currentChid}\n`;
        }
        
        if (this.currentBookName) {
            contextInfo += `当前操作的世界书: ${this.currentBookName}\n`;
        }

        let prompt = `你是一个专业的角色卡构建助手（Executor）。你的目标是根据 Reviewer 的指导和用户的需求，在当前选定的“工作区”（角色卡和世界书）中进行**创作**和修改。

${contextInfo}

**你的职责：**
1. **理解指令**：仔细阅读 Reviewer 的指导性指令。
2. **深度扩写**：这是你的核心任务。Reviewer 给出的只是大纲，你需要将其扩写成丰富、细腻的文学作品。
   - **世界书条目**：必须丰富细节，字数**不低于 300 字**。
   - **角色开场白**：必须包含环境描写、心理活动、动作细节，字数**不低于 1500 字**。
3. **执行操作**：使用工具将你创作的内容写入系统。

TOOL USE

你拥有以下工具可以使用。你可以使用这些工具来完成任务。每次回复只能使用一个工具。

# Tools

`;

        toolDefs.forEach(tool => {
            prompt += `## ${tool.name}\n`;
            prompt += `Description: ${tool.description}\n`;
            prompt += `Parameters:\n${JSON.stringify(tool.parameters, null, 2)}\n\n`;
        });

        prompt += `
### 世界书高级设置指南 (World Info Settings)
- **constant (蓝灯)**: 如果为 true，该条目将始终被激活并包含在上下文中，忽略关键词触发。
- **position (插入位置)**: 决定条目内容在 Prompt 中的位置。
  - \`before/after_character_definition\`: 角色定义前后。
  - \`before/after_author_note\`: 作者注释前后。
  - \`at_depth_as_system\`: 在指定深度作为系统消息插入（推荐）。
- **depth (插入深度)**: 仅当 position 为 \`at_depth_as_system\` 时有效。表示条目距离最新消息的距离（例如 0 为最新，4 为倒数第 4 条消息后）。
- **scanDepth (扫描深度)**: 系统扫描关键词的消息范围。例如 2 表示只扫描最近 2 条消息。
- **exclude_recursion**: 如果为 true，此条目的内容不会触发其他条目。
- **prevent_recursion**: 如果为 true，其他条目的内容不会触发此条目。

# Tool Use Formatting

工具调用必须使用以下 XML 格式。工具名称包含在开始和结束标签中，每个参数也包含在自己的标签中：

<工具名称>
<参数1>值1</参数1>
<参数2>值2</参数2>
...
</工具名称>

**注意**：对于复杂参数（如数组或对象），请直接在标签内写入 **JSON 字符串**。

例如：
<write_world_info_entry>
<book_name>MyWorld</book_name>
<entries>[{"key": "Entry1", "content": "..."}]</entries>
</write_world_info_entry>

# Tool Use Guidelines

1. **必须思考 (Mandatory Thinking)**: 在调用任何工具之前，你**必须**先输出一段思考过程，解释你为什么要这样做，以及你打算如何创作内容。请使用 \`<thinking>\` 标签包裹你的思考。**严禁**直接输出工具调用而不进行思考。
2. **单步执行**: 每次回复只能使用**一个**工具。必须等待工具执行结果（成功或失败）后，才能决定并执行下一步操作。
3. **等待确认**: 永远不要假设工具执行成功。必须根据实际返回的结果来判断。
4. **参数完整性**: 确保提供所有必需的参数。

# Capabilities

- 你可以读取和修改当前绑定的世界书（World Info）。
- 你可以读取和修改当前角色的详细信息（Name, Description, Personality, Scenario, First Message, etc.）。
- 你可以管理角色的开场白（添加、修改、删除）。

# Rules

1. **工作区**: 你始终在当前选定的角色卡和世界书上下文中操作。
2. **路径**: 如果涉及文件路径（虽然主要通过 API 操作），请认为是相对于工作区的虚拟路径。
3. **完成任务**: 当你认为任务已经完成时，请向用户汇报结果。不要在汇报结果后继续提问。

现在，请开始你的工作。
`;
        return prompt;
    }

    async handleUserMessage(message, onStreamUpdate, onPreviewUpdate) {
        this.history.push({ role: 'user', content: message });
        
        this.reviewerHistory.push({ role: 'user', content: message });

        await this.runDualAgentLoop(onStreamUpdate, onPreviewUpdate);
    }

    async runDualAgentLoop(onStreamUpdate, onPreviewUpdate) {
        let maxLoops = 3; 
        let currentLoop = 0;

        while (currentLoop < maxLoops) {
            currentLoop++;

            onStreamUpdate("Reviewer (模型B) 正在思考...", 'system');
            
            const reviewerConfig = getApiConfig('reviewer');
            const reviewerMessages = this.contextManager.buildMessages(
                this.reviewerSystemPrompt, 
                this.reviewerHistory, 
                reviewerConfig.maxTokens
            );

            let reviewerResponse;
            try {
                reviewerResponse = await callAi('reviewer', reviewerMessages);
            } catch (error) {
                onStreamUpdate(`[Reviewer 错误] ${error.message}`, 'system');
                return;
            }

            const instructionMatch = reviewerResponse.match(/<instruction>([\s\S]*?)<\/instruction>/);
            const instruction = instructionMatch ? instructionMatch[1].trim() : null;
            
            const displayContent = reviewerResponse.replace(/<instruction>[\s\S]*?<\/instruction>/, '').trim();
            
            if (displayContent) {
                onStreamUpdate(displayContent, 'assistant'); 
                this.history.push({ role: 'assistant', content: displayContent });
                this.reviewerHistory.push({ role: 'assistant', content: displayContent });
            }

            if (!instruction) {
                break;
            }

            onStreamUpdate(`Reviewer 指令: ${instruction}`, 'system');
            
            this.executorHistory.push({ role: 'user', content: instruction }); 
            
            await this.runExecutorLoop(onStreamUpdate, onPreviewUpdate);

            const lastExecutorResponse = this.executorHistory[this.executorHistory.length - 1];
            if (lastExecutorResponse && lastExecutorResponse.role === 'assistant') {
                this.reviewerHistory.push({ 
                    role: 'user', 
                    content: `[Executor 执行结果]\n${lastExecutorResponse.content}` 
                });
            }
        }
    }

    async runExecutorLoop(onStreamUpdate, onPreviewUpdate) {
        let maxTurns = 5;
        let currentTurn = 0;

        while (currentTurn < maxTurns) {
            currentTurn++;
            
            const executorConfig = getApiConfig('executor');
            const messages = this.contextManager.buildMessages(
                this.executorSystemPrompt, 
                this.executorHistory,
                executorConfig.maxTokens
            );

            let responseContent;
            try {
                responseContent = await callAi('executor', messages);
            } catch (error) {
                onStreamUpdate(`[Executor 错误] ${error.message}`, 'system');
                return;
            }

            onStreamUpdate(responseContent, 'executor'); 
            this.executorHistory.push({ role: 'assistant', content: responseContent });

            const toolCall = this.parseToolCall(responseContent);
            
            if (toolCall) {
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

                onStreamUpdate(`[Executor] 执行工具: ${toolCall.name}`, 'system');
                
                let result;
                try {
                    if (tools[toolCall.name]) {
                        result = await tools[toolCall.name](toolCall.arguments);
                        
                        if (toolCall.name === 'create_character' && result.includes('ID:')) {
                            const match = result.match(/ID:\s*(\d+)/);
                            if (match) {
                                this.currentChid = parseInt(match[1]);
                                this.executorSystemPrompt = this.buildExecutorSystemPrompt();
                            }
                        }
                    } else {
                        result = `Error: Tool '${toolCall.name}' not found.`;
                    }
                } catch (error) {
                    result = `Error executing tool '${toolCall.name}': ${error.message}`;
                }

                const toolResultMsg = `[Tool Result for ${toolCall.name}]\n${result}`;
                this.executorHistory.push({ role: 'user', content: toolResultMsg });
                
                onStreamUpdate(`[Executor] 工具结果: ${result.substring(0, 100)}...`, 'system');

                if (onPreviewUpdate && !result.startsWith('Error')) {
                    onPreviewUpdate(toolCall.name, toolCall.arguments);
                }
            } else {
                break;
            }
        }
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
    
    clearHistory() {
        this.history = [];
        this.executorHistory = [];
        this.reviewerHistory = [];
    }
}
