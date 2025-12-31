export class TaskState {
    constructor() {
        this.reset();
    }

    reset() {
        this.originalRequest = "";
        this.currentGoal = "";
        this.completedSteps = []; // Array of strings
        this.pendingSteps = []; // Array of strings
        this.summary = ""; // The structured summary of the character/world so far
        this.generatedData = {}; // Key-value pairs of generated attributes (e.g., name, personality)
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

    getPromptContext() {
        let context = `\n# Task State\n`;
        context += `- **Original Request**: ${this.originalRequest}\n`;
        context += `- **Current Goal**: ${this.currentGoal}\n`;
        
        if (this.completedSteps.length > 0) {
            context += `- **Completed Steps**:\n${this.completedSteps.map(s => `  - ${s}`).join('\n')}\n`;
        }
        
        if (this.pendingSteps.length > 0) {
            context += `- **Pending Steps**:\n${this.pendingSteps.map(s => `  - ${s}`).join('\n')}\n`;
        }

        if (this.summary) {
            context += `\n# Memory & Context Summary\n${this.summary}\n`;
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
        this.lastSummaryTimestamp = json.lastSummaryTimestamp || 0;
    }
}
