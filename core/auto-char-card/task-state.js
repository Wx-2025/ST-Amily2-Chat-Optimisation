export class TaskState {
    constructor() {
        this.reset();
    }

    reset() {
        this.originalRequest = "";
        this.currentGoal = "";
        this.completedSteps = [];
        this.pendingSteps = [];
        this.summary = ""; 
        this.generatedData = {};
        this.style_reference = "";
        this.keyFacts = [];
        this.lastSummaryTimestamp = 0;
    }

    init(request) {
        this.reset();
        this.originalRequest = request;
        this.currentGoal = "Analyze request and plan steps";
        this.lastSummaryTimestamp = Date.now();
    }

    updateSummary(newSummary) {
        this.summary = newSummary;
        this.lastSummaryTimestamp = Date.now();
    }

    addCompletedStep(step) {
        this.completedSteps.push(step);
    }

    setPendingSteps(steps) {
        this.pendingSteps = steps;
    }

    setCurrentGoal(goal) {
        this.currentGoal = goal;
    }

    updateGeneratedData(key, value) {
        this.generatedData[key] = value;
    }

    setStyle(style) {
        this.style_reference = style;
    }

    addKeyFacts(facts) {
        this.keyFacts.push(...facts);
    }

    getPromptContext() {
        let context = `\n# Task State\n`;
        context += `- **Original Request**: ${this.originalRequest}\n`;
        context += `- **Current Goal**: ${this.currentGoal}\n`;
        
        if (this.style_reference) {
            context += `- **Style Reference**: ${this.style_reference}\n`;
        }

        if (this.completedSteps.length > 0) {
            context += `- **Completed Steps**:\n${this.completedSteps.map(s => `  - ${s}`).join('\n')}\n`;
        }
        
        if (this.pendingSteps.length > 0) {
            context += `- **Pending Steps**:\n${this.pendingSteps.map(s => `  - ${s}`).join('\n')}\n`;
        }

        if (this.keyFacts.length > 0) {
            context += `\n# Key Facts (Long Term Memory)\n`;
            this.keyFacts.forEach(fact => context += `- ${fact}\n`);
        }

        if (this.summary) {
            context += `\n# Recent Context Summary\n${this.summary}\n`;
        }

        return context;
    }
    
    toJSON() {
        return {
            originalRequest: this.originalRequest,
            currentGoal: this.currentGoal,
            completedSteps: this.completedSteps,
            pendingSteps: this.pendingSteps,
            summary: this.summary,
            generatedData: this.generatedData,
            style_reference: this.style_reference,
            keyFacts: this.keyFacts,
            lastSummaryTimestamp: this.lastSummaryTimestamp
        };
    }

    fromJSON(json) {
        if (!json) return;
        this.originalRequest = json.originalRequest || "";
        this.currentGoal = json.currentGoal || "";
        this.completedSteps = json.completedSteps || [];
        this.pendingSteps = json.pendingSteps || [];
        this.summary = json.summary || "";
        this.generatedData = json.generatedData || {};
        this.style_reference = json.style_reference || "";
        this.keyFacts = json.keyFacts || [];
        this.lastSummaryTimestamp = json.lastSummaryTimestamp || 0;
    }
}
