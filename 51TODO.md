# 51TODO — 劳动节后开工清单

> 创建于 2026-04-28。计划在 5月1日劳动节假后启动。
> 本文件聚焦跨方向工作（Bus 升级 + 整体节奏）。
> 表格模块的解耦与三模式落地详见 [TableTODO.md](TableTODO.md)。

---

## 一、全景

两条并行主线：

1. **Bus tool-call 能力升级**（本文 Phase A） —— 让任何 Amily2Bus 注册的插件都能定义自己的 tool_calls 工具集，LLM 调用时自动 dispatch 回 handler，跑 agent loop。
2. **表格模块重构 + 三模式填表** —— 解耦 manager.js 上帝模块；新增 JSON / toolcall 填表模式；保留 legacy 默认，老用户零感知。详见 [TableTODO.md](TableTODO.md)。

两条线**可并行**，仅在表格的 toolcall 模式（TableTODO Phase C）落地时需要 Bus Phase A 完成。

---

## 二、Phase A：Bus tool-call 升级

### A.1 ToolRegistry

- 新文件 `SL/bus/tool/ToolRegistry.js`
- 内部 `Map<pluginName, Map<toolName, { def, handler }>>`
- 完全私有，不跨插件查询（每个模块自己用自己的工具集，不共享）

### A.2 plugin context 加 tool 能力

- `register(pluginName)` 返回的 context 上挂 `tool`：
  - `define(name, { description, parameters }, handler)`
  - `undefine(name)`
  - `list()`

### A.3 Options + RequestBody 透传 tools

- [Options.js](SL/bus/api/Options.js) 加 `tools` / `toolChoice` 字段
- [RequestBody.toPayload](SL/bus/api/RequestBody.js) 在有 tools 时包进 payload
- `ModelCaller._normalize` 在响应含 `tool_calls` 时返回完整 message 对象（而非只返字符串）—— 注意做后向兼容标记

### A.4 callWithTools agent loop

- `context.model.callWithTools(messages, options, { maxSteps = 8, onToolError = 'feedback' })`
- 自动拼本插件 define 的工具进 request
- 收 tool_calls → 串行 dispatch 到对应 handler → tool result 回喂 messages
- handler 抛错时 catch，把 error string 作为 tool_result 喂回 LLM 让其自纠
- maxSteps 兜底，防死循环

**Phase A 验收**：

- [ ] 写一个最简 ping tool 跑通 round-trip
- [ ] handler 抛错回喂 LLM，LLM 能自纠
- [ ] maxSteps 截断行为正确

**预估**：1.5 天人时，风险中（agent loop 边界条件多）。

---

## 三、跨方向决策点

> 假后开工前先拍：

1. **Phase A 与 TableTODO Phase 0 谁先**：
   - 选项 A：先 Phase A（Bus 升级），再 Table Phase 0
   - 选项 B：先 Table Phase 0（解耦），再 Phase A
   - 选项 C：并行两条分支
   - 倾向：B（Table Phase 0 不依赖 Bus，先把表格上帝模块拆了，后续 Phase A 也好用 ToolRegistry）

2. **Phase A 是否必须 ship 才能开 Table Phase B**：
   - 不必须。Phase B（JSON formatter）独立。Phase C（toolcall）才依赖 Phase A。

3. **是否合并发版**：
   - 选项 A：Phase 0 → 单独 ship → Phase A → ship → Phase B/C → ship（增量发布，回归风险低）
   - 选项 B：全部攒一起一次性发（节奏简单但风险高）
   - 倾向：A，每完成一段先发，老用户始终能用 legacy。

---

## 四、不在范围内

- 不重写 ui/table-bindings.js
- 不改持久化 schema
- 不改 SuperMemory 集成
- 不引入 TypeScript

---

## 五、工时汇总

| 主线 | 子项 | 估时 |
| ---- | ---- | ---- |
| Bus | Phase A (tool-call 升级) | 1.5 天 |
| 表格 | TableTODO Phase 0-C | ~5 天（详见 TableTODO §十） |
| 验收 | 整体回归 + UI 验证 | 1 天 |

**合计 ~7.5 天人时。** 假期 5 天 + 假后两周缓冲，5 月底前可全量上线。
