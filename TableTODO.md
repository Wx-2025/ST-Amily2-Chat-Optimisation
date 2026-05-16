# TableTODO — 表格模块重构清单

> 创建于 2026-04-28。劳动节假后启动。
> 主线：解耦 → 三模式填表（legacy / json / toolcall）。
> 跨方向依赖（Bus tool-call 升级）见 [51TODO.md](51TODO.md) Phase A。

---

## 一、动机

现行表格填表让 LLM 输出 `<Amily2Edit>insertRow(0, {0:"x",1:"y"})</Amily2Edit>` 这种"四不像"自定义文本格式，由 [executor.js#parseFunctionCall](core/table-system/executor.js#L98) 自实现的 brace-depth + quote-state 状态机解析。高温下：
- 引号转义错乱、嵌套对象内逗号未转义 → 参数切错位
- `data` 对象键写成无引号字段名 → 多层 JSON.parse fallback 仍可能失败
- 一处 LLM 偷懒不输出 `<Amily2Edit>` → 整批回滚重试

**目标**：把"格式契约"从 prompt 字符串约定改成 schema 约定，让 LLM 直接吐结构化数据，砍掉自实现解析器。同时保留 legacy 文本模式确保老用户行为不变。

| 模式 | 输出形态 | 解析复杂度 | 兼容性 |
|------|---------|-----------|--------|
| `legacy`（默认） | `<Amily2Edit>insertRow(...)</Amily2Edit>` 文本块 | 高（现行解析器） | 100% 老行为 |
| `json` | `{ "operations": [{op, tableIndex, ...}] }` 单 JSON 块 | 中（JSON.parse + schema 校验） | 新模式 |
| `toolcall` | OpenAI tool_calls 多步迭代 | 低（结构化原生） | 依赖 Bus 升级（51TODO Phase A） |

---

## 二、当前耦合分析（2026-04-28 摸底）

### 2.1 manager.js 是上帝模块
- 1745 行，51 个 export
- 七层职责混杂：状态容器 / 持久化 / UI 突变操作 / LLM 指令执行 / Markdown 提示词渲染 / 模板 getter setter / 预设导入导出 / 回滚 / 跨模块事件分发

### 2.2 状态所有权
- module-level mutable：`currentTablesState`、`highlightedCells`、`updatedTables`（[manager.js:16-20](core/table-system/manager.js#L16-L20)）
- 20+ export 函数直接 mutate，没有封装边界

### 2.3 持久化模式被复制 16 次
每个 UI 突变 export 末尾都有同款样板：
```js
const context = getContext();
if (context.chat && context.chat.length > 0) {
    const lastMessage = context.chat[context.chat.length - 1];
    if (saveStateToMessage(currentTablesState, lastMessage)) {
        saveChat();
        return;
    }
}
saveChatDebounced();
```
受影响：addRow / addColumn / updateHeader / deleteRow / restoreRow / insertColumn / moveColumn / deleteTable / addTable / renameTable / moveTable / updateTableRules / updateRow / clearAllTables / updateColumnWidth / insertRow

### 2.4 三个 filler 大量重复
- [secondary-filler.js#getWorldBookContext](core/table-system/secondary-filler.js#L16) ≈ [batch-filler.js#getWorldBookContext](core/table-system/batch-filler.js#L25)（含微妙差异：character book 来源处理不同）
- mixed-order 拼装循环 + `callNccsAI vs callAI` 分支三处 copy
- 三者都调 `updateTableFromText(rawContent)` 收尾

### 2.5 业务层硬依赖 UI 层
[manager.js:9-10](core/table-system/manager.js#L9-L10)：
```js
import { renderTables } from '../../ui/table-bindings.js';
import { updateOrInsertTableInChat } from '../../ui/message-table-renderer.js';
```
在 loadMemoryState / deleteRow / restoreRow / rollbackState / updateTableFromText 里直调。逻辑和渲染焊死。

### 2.6 提示词构建散在 4 个文件
- 模板常量：[settings.js](core/table-system/settings.js)
- getter：[manager.js:1244-1259](core/table-system/manager.js#L1244)
- 占位符替换 `flowTemplate.replace('{{{Amily2TableData}}}', ...)`：secondary-filler / batch-filler / reorganizer / injector 各自一份

### 2.7 格式锁死（重构核心痛点）
`<Amily2Edit>` 文本格式硬编码在 4 处：
- [executor.js#L98-202](core/table-system/executor.js#L98) 解析器
- [settings.js#L11-16](core/table-system/settings.js#L11) 模板示例
- [manager.js#updateTableFromText](core/table-system/manager.js#L1266) 入口
- [secondary-filler.js#L292](core/table-system/secondary-filler.js#L292) 失败检测 `if (!rawContent.includes('<Amily2Edit>'))`

### 2.8 循环依赖
- [manager.js:5](core/table-system/manager.js#L5) → `secondary-filler.js`
- [secondary-filler.js:7](core/table-system/secondary-filler.js#L7) → `manager.js`
- 引发点：`manager.rollbackAndRefill` 需要调 `fillWithSecondaryApi`

### 2.9 TableSystemService 是半成品门面
[TableSystemService.js](core/table-system/TableSystemService.js) 把 manager / executor / secondary-filler / ui 全 import 后再 expose，没解耦任何东西，只是 Bus 注册帖。

---

## 三、目标分层

```
┌────────────────────────────────────────────────────────────┐
│  UI Layer (existing, untouched)                              │
│  ui/table-bindings.js · ui/message-table-renderer.js         │
└────────────────────▲────────────────────────────────────────┘
                     │ 仅订阅事件，不被业务层 import
┌────────────────────┴────────────────────────────────────────┐
│  Service Layer (TableSystemService 真正承担门面)             │
│  ├─ 编排：fill/reorganize/rollback                           │
│  ├─ Bus 注册                                                 │
│  └─ 通过事件通知 UI（而非 import）                           │
└────────────────────▲────────────────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────────────────┐
│  Pipeline Layer (新增，三模式落地点)                         │
│  ├─ formatters/legacy.js   : <Amily2Edit> prompt + parse     │
│  ├─ formatters/json.js     : JSON prompt + parse             │
│  ├─ formatters/toolcall.js : Bus tool_calls (依赖 Bus 升级)  │
│  ├─ formatters/index.js    : 按 settings 分发                │
│  └─ filler/                                                  │
│      ├─ shared.js          : worldbook + history + 拼装       │
│      ├─ secondary.js       : 触发条件 + 用 shared             │
│      └─ batch.js           : 批次循环 + 用 shared             │
└────────────────────▲────────────────────────────────────────┘
                     │ 输出统一 Operation[]
┌────────────────────┴────────────────────────────────────────┐
│  Operation Layer (从 executor.js 抽出)                       │
│  operations.js                                               │
│  ├─ applyOperations(state, ops) → { state, changes }         │
│  └─ schema: Op = { op, tableIndex, ...args }                 │
└────────────────────▲────────────────────────────────────────┘
                     │
┌────────────────────┴────────────────────────────────────────┐
│  Domain Layer (从 manager.js 拆出)                            │
│  ├─ store.js     : currentTablesState 单一所有权 + 订阅       │
│  ├─ persist.js   : saveStateToMessage / load / 持久化封装    │
│  ├─ mutations.js : addRow/addColumn/.../updateRow 突变 API   │
│  ├─ rendering.js : convertTablesToCsvString * 3 (纯函数)      │
│  ├─ templates.js : prompt 模板 getter setter                  │
│  └─ preset.js    : 导入导出 / 全局预设                        │
└──────────────────────────────────────────────────────────────┘
```

**关键原则**
- Domain Layer 是纯逻辑，**禁止 import UI**
- Service Layer 与 UI 通过事件解耦（已有 events-schema.js 基础设施）
- Pipeline Layer 的 formatter 是可插拔的，新增格式 = 加文件，不动旧文件
- `currentTablesState` 由 store.js 独占，对外只有 `getState() / setState() / subscribe()`

---

## 四、Phase 0：解耦准备（必须先做）

下列任务**不引入新功能**，只重排现有代码。每条独立可 ship。

### 0.1 抽出 store.js（单一所有权）
- 文件：`core/table-system/domain/store.js`
- 把 `currentTablesState` / `highlightedCells` / `updatedTables` 搬过来
- 提供：`getState() / setState() / addHighlight / clearHighlights / getUpdatedTables / subscribe(listener)`
- manager.js 改为代理调用

### 0.2 抽出 persist.js（消除 16 处持久化样板）
- 文件：`core/table-system/domain/persist.js`
- 提供 `commitToLastMessage(state)`：封装 `getContext + saveStateToMessage + saveChat + fallback`
- 替换 manager.js 16 处样板

### 0.3 抽出 operations.js（解锁三模式的关键）
- 文件：`core/table-system/operations.js`
- 把 [executor.js insertRow/updateRow/deleteRow](core/table-system/executor.js#L3-L89) 抽成纯函数
- schema：`Op = { op: 'insertRow'|'updateRow'|'deleteRow', tableIndex, rowIndex?, data? }`
- API：`applyOperations(state, ops): { state, changes }`
- executor.js 改名 → `formatters/legacy.js`，只保留文本解析 → 输出 Op[] → 调 applyOperations

### 0.4 拆 mutations.js
- 文件：`core/table-system/domain/mutations.js`
- 把 manager.js 里 16 个突变 export（addRow / addColumn 等）搬过来
- 全部改为：调 store.setState + persist.commitToLastMessage + 发事件
- **删除**对 ui/* 的所有 import；改为 `store.subscribe` 让 UI 自己订阅刷新

### 0.5 拆 rendering.js
- 文件：`core/table-system/domain/rendering.js`
- 把 [convertTablesToCsvString](core/table-system/manager.js#L1005) / [convertSelectedTablesToCsvString](core/table-system/manager.js#L1096) / [convertTablesToCsvStringForContentOnly](core/table-system/manager.js#L1201) 搬过来
- 都做成纯函数 `(state, options?) => string`，不依赖 store

### 0.6 拆 templates.js + preset.js
- `domain/templates.js`：getBatchFillerRuleTemplate / saveBatchFillerRuleTemplate / Flow 同款
- `domain/preset.js`：exportPreset / importPreset / clearGlobalPreset / importGlobalPreset

### 0.7 抽出 fillerShared.js（消除三 filler 重复）
- 文件：`core/table-system/filler/shared.js`
- 提供：
  - `getWorldBookContext(settings)` — 合并 secondary 和 batch 两份的差异，参数化处理
  - `buildHistoryContext(opts)` — 统一对话历史拼装
  - `buildMessages(scope, { worldbook, history, coreContent, flowPrompt, ruleTemplate })` — mixed-order 循环 + presetPrompts 拼装
  - `callModel(messages, settings)` — 统一 nccsEnabled 分支
- secondary-filler.js / batch-filler.js / reorganizer.js 改用 shared

### 0.8 解循环依赖
- manager.js 的 `rollbackAndRefill` 不直接 import `fillWithSecondaryApi`
- 改为：在 service 层 (TableSystemService) 编排"先 rollback 再 fill"
- manager（或新的 mutations.js）只暴露 rollbackState

### 0.9 TableSystemService 真正变成门面
- 不再 `import * as TableManager` + 一一 expose
- 改为：内部组合 store / persist / mutations / formatters / filler，对外只暴露稳定接口
- 现有 `processMessageUpdate` 保留

**Phase 0 完成验收**：
- [ ] manager.js 缩到 < 200 行（仅作为 deprecation 兼容层重导出 + 标 @deprecated）
- [ ] 任何 domain/* 文件都不 import ui/*
- [ ] 三个 filler 共用 fillerShared.js，各自只有 ~100 行
- [ ] 现行 legacy 模式行为完全不变（手动验证）

---

## 五、Phase B：JSON formatter

> 依赖 Phase 0。不依赖 Bus 升级（Phase A）。

### B.1 formatters/json.js
- prompt 模板：教 LLM 输出 `{ "operations": [{ "op": "insertRow", "tableIndex": 0, "data": { "0": "...", "1": "..." } }] }`
- 解析：`JSON.parse` + schema 校验 → Op[]
- 输出 Op[] 给 applyOperations

### B.2 设置项与 UI
- 新设置：`settings.table_filling_format: 'legacy' | 'json' | 'toolcall'`，默认 `legacy`
- 表格设置面板加 dropdown
- 默认值保证老用户零感知

### B.3 集成到 fillerShared
- shared.callModel 调完后传 raw response 给当前 formatter
- formatter 返回 Op[]
- shared 负责 applyOperations + persist + 发事件

**Phase B 验收**：
- [ ] 切换到 json 模式后，手动跑分步填表 + 批量填表 + 重新整理 三种场景都能成功
- [ ] 回切 legacy 行为不变

---

## 六、Phase C：ToolCall formatter

> 依赖 Phase 0 + 51TODO Phase A（Bus tool-call 升级）+ Phase B（B 已经把 formatter 切换走通了）。

### C.1 formatters/toolcall.js
- 注册 Bus 工具：`table.insertRow / table.updateRow / table.deleteRow`
- 工具 parameters 用标准 JSONSchema 描述
- handler 内部调 `applyOperations`（其实是收集 Op[] 累加）
- 让 fillerShared 在该模式下走 `model.callWithTools`，loop 跑完后取累计的 Op[]

### C.2 终止条件
- LLM 在某轮没有吐 tool_calls 即停（对应"我已填完"的语义信号）
- maxSteps 兜底

### C.3 Prompt 调整
- toolcall 模式下不需要 `<Amily2Edit>` 教学，prompt 简化
- 但要保留 `{{{Amily2TableData}}}` 注入当前状态作为参考

**Phase C 验收**：
- [ ] toolcall 模式跑通分步填表
- [ ] 串表问题肉眼对比 legacy 显著减少
- [ ] handler 内 tableIndex 不存在时回喂 LLM 能自纠

---

## 七、表格部分决策点

> 重构前需要确认：

1. **填表格式开关粒度**：全局一个？还是分步 / 批量 / 重整 三个独立？
   - 倾向：全局一个 `table_filling_format`，简化 UI

2. **JSON 模式形态**：
   - A：单 JSON 块 `{"operations":[...]}` 直球到底
   - B：允许 LLM 在 ops 前后写自由文本（像 toolcall 那样夹带推理）
   - 倾向：A，简单可靠

3. **toolcall 终止条件**：
   - A：模型某轮无 tool_calls 即停 + maxSteps 兜底
   - B：必须显式调 `commit_table_changes` 工具才算完
   - 倾向：A

4. **manager.js 兜底兼容期**：
   - 拆解后保留 manager.js 作 re-export 兼容层多久？
   - 倾向：保留至 2.0.2，2.0.3 删除

---

## 八、不在范围内（明确不做）

- 不重写 ui/table-bindings.js（UI 层独立演进）
- 不改持久化 schema（`message.extra.amily2_tables_data` 保持）
- 不改 SuperMemory 集成（继续走 Bus query + CustomEvent fallback）
- 不引入 TypeScript（DTS 注释为主）
- Phase 0 阶段不动 prompt 模板内容（只挪文件位置）

---

## 九、入手顺序

1. Phase 0.3（operations.js）—— 影响面小，立刻能验证 executor 抽离不破坏 legacy
2. Phase 0.1 + 0.2（store + persist）—— 给后续 mutations 拆解铺路
3. Phase 0.4-0.6 —— manager.js 收缩主战
4. Phase 0.7-0.9 —— filler 重复消除 + 循环依赖
5. Phase 0 整体回归
6. Phase B（独立可走，不等 Bus 升级）
7. Phase C（等 51TODO Phase A 完成后再做）

---

## 十、工时（粗）

| Phase | 预估 | 风险 |
|-------|------|------|
| 0.1-0.3 (store/persist/operations) | 1 天 | 低 |
| 0.4-0.6 (mutations/rendering/templates) | 1 天 | 中（manager.js 删减易漏） |
| 0.7-0.9 (filler / 循环依赖 / Service) | 1 天 | 中（filler 三方差异需仔细对齐） |
| Phase B | 0.5 天 | 低 |
| Phase C | 0.5 天 | 低（前置都搞完了，纯组装） |
| 回归测试 | 1 天 | — |

合计 ~5 天人时（不含 Bus 升级，那部分见 51TODO）。
