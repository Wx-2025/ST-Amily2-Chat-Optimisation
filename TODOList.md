# TODOList — 待办任务总览

> 用于派工与进度跟踪。任务卡格式统一，可拆分给不同执行者（人 / Claude / GPT / 其他模型）。
>
> 关联文档：
> - [51TODO.md](51TODO.md) — 跨方向重构计划（Bus tool-call 升级 / 跨议题决策点）
> - [TableTODO.md](TableTODO.md) — 表格模块 IAD 深度重构计划（Phase 0/B/C）
> - [TODO.md](TODO.md) — 旧版本变更日志（保留作为发布记录）
>
> 最后更新：2026-05-08，对应 v2.2.0 已发布。

---

## 一、最近落地（v2.1.1 → v2.2.0）

> 上下文摘要，让接手者了解当前状态。代码细节看对应 commit。

| commit | 内容 | 涉及范围 |
|--------|------|--------|
| `d283ff4` | 表格模块 IAD 解耦 + API 自定义参数 + 厂商预设连接 | `core/table-system/*` 新增 dto/infra/actions；`assets/api-vendor-params.json`；UI |
| `f022002` | DeepSeek registry 补 thinking 模式参数 | `assets/api-vendor-params.json` |
| `671c1b2` | profile 优先级修正：profile 分配后即权威，旧字段不再覆盖 | `core/api.js` 6 处 `getApiSettings` |
| `68217ff` | legacy 自动迁移 + 清除按钮 + tableFilling slot + silent fallback 移除 | `ApiProfileManager.js` / `historiographer.js` / 表格 3 filler |
| `b40f575` | bump 2.2.0 + tableFilling 默认 link main | `manifest.json` / `ApiProfileManager.js` |

**核心架构现状**（接手必读）：

- **状态权威**：`utils/config/ApiProfileManager.js` 是 API 配置单一指挥所；profile 分配后即权威，旧字段（`s.ngmsTemperature` 等）不再覆盖 profile
- **表格模块**：核心在 [core/table-system/](core/table-system/) ，已按 IAD 拆分（dto/infra/actions/rendering.js/templates.js/preset.js），manager.js 退化为兼容层（仍保留 16 个 UI mutation + loadTables + updateTableFromText）
- **API 厂商识别**：[utils/api-vendor.js](utils/api-vendor.js) 提供 detectVendor / listVendorParams；registry 在 [assets/api-vendor-params.json](assets/api-vendor-params.json)
- **VS Code 类型校验**：[jsconfig.json](jsconfig.json) 已开启 checkJs，[types/sillytavern.d.ts](types/sillytavern.d.ts) 提供 SillyTavern 全局模块声明

---

## 二、待办任务

### 任务卡格式说明

每个任务包含：
- **类型**：bug / feature / refactor / cleanup / docs
- **难度**：🟢 简单（< 1h）／ 🟡 中等（1-3h）／ 🔴 高耦合（> 3h 或需架构判断）
- **建议执行者**：`GPT` / `Claude` / `Human` / `任意`
- **文件**：明确路径 + 行号锚点（若适用）
- **修改要点**：bullet 列表
- **验收**：可验证的预期行为
- **依赖**：前置任务的 ID（若有）

---

### 🟢 GPT-friendly 简单任务

#### T-001: 清理已确认的死代码

- **类型**：cleanup
- **难度**：🟢 简单
- **建议执行者**：GPT
- **依赖**：无

**待清理项**：

1. **[core/fractal-memory.js](core/fractal-memory.js)** —— 整个文件死代码，`initializeFractalMemory` 在文件外完全没人调用。建议：直接删除整个文件。
2. **[ui/historiography-bindings.js:494-513](ui/historiography-bindings.js#L494)** —— 绑定 `#amily2_ngms_temperature` 和 `#amily2_ngms_max_tokens` 这两个 HTML 中已不存在的元素。`getElementById` 永远返回 null，整段代码空跑。建议：直接删掉这段。
3. **[ui/plot-opt-bindings.js:664-665](ui/plot-opt-bindings.js#L664)** —— 同样引用不存在的 `#amily2_opt_max_tokens` / `#amily2_opt_temperature`。建议：删掉。
4. **[ui/plot-opt-bindings.js:698-699](ui/plot-opt-bindings.js#L698)** —— `opt_bindSlider` 调用同样的不存在 ID，删除。

**修改要点**：
- 删除前用 grep 确认每个 ID 在所有 .html 文件里都不存在
- 删完后用 grep 检查没有其他文件 import 被删的函数
- 提交前肉眼跑一次表格填表 / 剧情优化 / NGMS 总结，确认 UI 无回归

**验收**：
- [ ] 4 处死代码块全部删除
- [ ] 启动控制台无 JS 错误
- [ ] 表格 / 剧情优化 / 总结功能无回归

---

#### T-002: cwb / autoCharCard 加入 legacy 自动迁移

- **类型**：feature
- **难度**：🟢 简单
- **建议执行者**：GPT
- **依赖**：无

**背景**：[utils/config/ApiProfileManager.js](utils/config/ApiProfileManager.js) 的 `LEGACY_PROFILE_MIGRATION_MAP` 目前覆盖 main / plotOpt / plotOptConc / ngms / nccs / sybd 6 个 slot。cwb 和 autoCharCard 的 legacy 字段结构略不同（cwb 用 `cwb_apiUrl` / `cwb_apiKey` / `cwb_model` ；autoCharCard 用 `acc_*` 前缀），所以暂时没纳入。

**修改要点**：

1. 找出 cwb / autoCharCard 的 legacy 字段名（grep `cwb_apiUrl` / `acc_apiUrl` 之类）
2. 在 `LEGACY_PROFILE_MIGRATION_MAP` 加两条：
   ```js
   {
       slot: 'cwb',
       urlKey: 'cwb_apiUrl',
       modelKey: 'cwb_model',
       keyName: 'cwb_apiKey',
       maxTokensKey: 'cwb_max_tokens',
       temperatureKey: 'cwb_temperature',
       name: 'CWB 旧配置',
   },
   {
       slot: 'autoCharCard',
       urlKey: '???',  // 需 grep 确认实际 key
       ...
   }
   ```
3. 同时在 `clearLegacyConfig` 的 `ALL_LEGACY_FIELDS` 和 `LEGACY_KEY_NAMES` 加对应条目

**验收**：
- [ ] 两个 slot 在迁移自调用 IIFE 跑过后能正确创建 profile + setKey + setAssignment
- [ ] 清理按钮能识别并清除这俩模块的旧字段

---

#### T-003: 表格 NCCS 支路透传 customParams

- **类型**：feature
- **难度**：🟢 简单
- **建议执行者**：GPT
- **依赖**：无

**背景**：v2.2.0 给 `core/api.js` 的 callOpenAITest / callOpenAICompatible / callSillyTavernBackend 都接入了 `options.customParams` spread。但 [core/api/NccsApi.js](core/api/NccsApi.js) 的 `callNccsOpenAITest` 等独立路径**没有**接入，导致用户在 NCCS profile 配置的 customParams 不生效。

**修改要点**：

1. 找 [NccsApi.js](core/api/NccsApi.js) 里发请求的函数（`callNccsOpenAITest` / `callNccsSillyTavernPreset`），定位到 `JSON.stringify({ ... })` 处
2. 在 body 构建时按"customParams 在前，核心字段在后覆盖"的顺序 spread：
   ```js
   body: JSON.stringify({
       ...(options.customParams || {}),
       // 核心字段
       chat_completion_source: 'openai',
       model: options.model,
       messages,
       // ...
   })
   ```
3. 同时确保 `getNccsApiSettings` 把 `profile.customParams` 透出（参考 [core/api.js:447-462](core/api.js#L447) 模式）
4. 同步给 NgmsApi / JqyhApi / SybdApi 做相同处理

**验收**：
- [ ] 在 NCCS profile 加 `{"top_p": 0.5}` 后，DevTools Network 看请求 body 包含 top_p:0.5
- [ ] NGMS / JQYH / SYBD 同样验证

---

#### T-004: hint panel 点击参数名插入到 textarea

- **类型**：feature
- **难度**：🟢 简单
- **建议执行者**：GPT
- **依赖**：无

**背景**：[ui/api-config-bindings.js](ui/api-config-bindings.js) 的 `_updateCustomParamsHint` 现在只显示纯文本"已知参数：top_p、frequency_penalty、..."。没有交互。

**修改要点**：

1. 把 hint 区改成参数名按钮列表，每个按钮 click 触发"如果当前 textarea JSON 已有这个 key 则不动，没有就 append 进去"
2. 实现 `_insertParamToCustomParams(paramName, defaultValue)`：解析 textarea JSON → 添加 key（用合理的占位值，例如 number 类型用 0、string 类型用 ""、object 类型用 {}）→ JSON.stringify 回写
3. 处理 textarea 当前为空 / 当前是非法 JSON 的情况（非法 JSON 时按钮 disabled + 提示用户先修复）

**验收**：
- [ ] 切换 vendor 后参数名按钮列表更新
- [ ] 点击按钮把对应 key 添加到 textarea
- [ ] 已存在的 key 不重复添加

---

### 🟡 中等任务

#### T-005: 15 处散乱 vendor URL 检查迁到 detectVendor

- **类型**：refactor
- **难度**：🟡 中等
- **建议执行者**：GPT 或 Claude
- **依赖**：无

**背景**：之前的 51TODO Phase B 收尾任务。代码里 15+ 处 `apiUrl.includes('googleapis.com')` 散乱判断厂商，应该统一调 [utils/api-vendor.js#detectVendor](utils/api-vendor.js)。

**待迁移文件**（grep `googleapis.com|anthropic.com|openai.com` 找）：

- `ui/api-config-bindings.js`
- `ui/plot-opt-bindings.js`
- `core/rag-api.js`
- `ui/profile-sync.js`
- `core/api.js`
- `CharacterWorldBook/src/cwb_apiService.js`
- `ui/bindings.js`
- `ui/table/nccs-bindings.js`
- `core/api/SybdApi.js`
- `core/api/Ngms_api.js`
- `core/api/JqyhApi.js`
- `core/api/NccsApi.js`
- `core/api/ConcurrentApi.js`

**修改要点**：

1. 每处 `if (apiUrl.includes('googleapis.com'))` 改为 `if ((await detectVendor(apiUrl)) === 'google')`
2. 注意有的位置在同步上下文（事件回调），用 `detectVendorSync` 但要先 `await getRegistry()` 预加载
3. 不要为了重构改变行为：原来只判断 google 就只判断 google，原来判断多个 vendor 就保留多个

**验收**：
- [ ] 所有散乱 URL 检查替换完
- [ ] 行为完全等价（用 grep 自检 includes 已全替换）
- [ ] 跑一遍主功能（主聊天 / 剧情优化 / NGMS 总结 / 表格填表）确认无回归

---

#### T-006: jqyh/sybd/cwb 在 profile 已分配时把 slider 改成 informational

- **类型**：feature / UX
- **难度**：🟡 中等
- **建议执行者**：GPT 或 Claude
- **依赖**：无

**背景**：v2.2.0 之后，profile 一旦分配就权威，jqyh/sybd/cwb 这些有 slider 的模块在 profile 分配后 slider 是无效的（用户改 slider 不影响请求）。这是用户陷阱。

**修改要点**：

每个有 slider 的模块面板（[plot-opt-bindings.js](ui/plot-opt-bindings.js) / [historiography-bindings.js](ui/historiography-bindings.js) / [glossary 相关 bindings](ui/) / [cwb_settingsManager.js](CharacterWorldBook/src/cwb_settingsManager.js)）：

1. 启动时 / profile 分配变化时检查对应 slot 是否分配了 profile
2. 若已分配：
   - slider disable
   - slider 旁加小字提示："当前由 profile 「{profile.name}」 控制，请在 API 连接配置面板修改 profile"
3. 若未分配：保持原样（slider 可用，写入 legacy 字段）
4. 监听 profile 分配变化事件（可通过 ApiProfileManager 加 subscribe，或者轮询）

**验收**：
- [ ] 给 plotOpt 分配 profile 后，剧情优化面板的温度/maxTokens slider 变灰 + 提示
- [ ] 取消分配后 slider 重新可用
- [ ] 其他模块同样行为

---

#### T-007: 表格 Phase 0.4 — 抽出 mutations.js

- **类型**：refactor
- **难度**：🟡 中等
- **建议执行者**：Claude（涉及 IAD 一致性判断）
- **依赖**：无

**背景**：[TableTODO.md#四-phase-0](TableTODO.md) 计划的 Phase 0.4。manager.js 还有 16 个 UI 突变函数（addRow / deleteColumn / renameTable 等），应抽到 `core/table-system/actions/ui-mutations.js`。

**修改要点**：

1. 在 `core/table-system/actions/` 创建 `ui-mutations.js`
2. 把 manager.js 里这 16 个函数搬过去：deleteColumn / moveRow / insertRow / addRow / addColumn / updateHeader / deleteRow / restoreRow / commitPendingDeletions / insertColumn / moveColumn / deleteTable / addTable / renameTable / moveTable / updateTableRules / updateRow / clearAllTables / updateColumnWidth
3. manager.js 改为 re-export 这些函数（保持外部调用路径不变）
4. 各函数签名/行为保持完全一致

**验收**：
- [ ] manager.js 行数显著减少
- [ ] 所有 UI 突变操作在表格面板里行为一致（手动测每个操作）
- [ ] 没有任何 import 失败

---

### 🔴 高耦合 / 架构任务

#### T-008: Bus tool-call 能力升级

- **类型**：feature / 架构
- **难度**：🔴 高
- **建议执行者**：Claude（涉及 Bus 架构判断）
- **依赖**：无（独立于表格重构）

**详见**：[51TODO.md#二-phase-a-bus-tool-call-升级](51TODO.md)

**核心交付**：
- `SL/bus/tool/ToolRegistry.js` 私有工具注册表
- `register(pluginName)` 返回的 context 加 `tool` 能力
- `Options.js` / `RequestBody.js` 支持 `tools` / `toolChoice` 字段
- `context.model.callWithTools(messages, options, { maxSteps, onToolError })` agent loop

**预估**：1.5 天

---

#### T-009: 表格 Phase B — JSON formatter

- **类型**：feature
- **难度**：🟡 中等
- **建议执行者**：GPT 或 Claude
- **依赖**：无（不依赖 Bus 升级）

**详见**：[TableTODO.md#五-phase-b-json-formatter](TableTODO.md)

**核心交付**：
- `core/table-system/formatters/json.js`：教 LLM 输出 `{"operations":[...]}`，解析为 Op[]
- 设置项 `table_filling_format: 'legacy'|'json'|'toolcall'`，默认 `legacy`
- UI 加 dropdown 切换
- fillerShared 调用统一 formatter dispatcher

**预估**：0.5 天

---

#### T-010: 表格 Phase C — ToolCall formatter

- **类型**：feature
- **难度**：🟡 中等
- **建议执行者**：Claude
- **依赖**：T-008 完成 + T-009 完成

**详见**：[TableTODO.md#六-phase-c-toolcall-formatter](TableTODO.md)

---

#### T-011: 表格 Phase 0.7-0.9 收尾

- **类型**：refactor
- **难度**：🔴 高（filler 三方差异需小心对齐 / 解循环依赖 / Service 重写）
- **建议执行者**：Claude
- **依赖**：T-007（Phase 0.4 mutations 完成后做）

**详见**：[TableTODO.md#四-phase-0](TableTODO.md) 0.7-0.9

- 0.7: `core/table-system/filler/shared.js` —— 三个 filler 重复代码消除
- 0.8: 解 manager.js ↔ secondary-filler.js 循环依赖
- 0.9: TableSystemService 真正变成门面

**预估**：1 天

---

## 三、派工建议

### 适合现在直接派给 GPT（独立、无架构判断）

- ✅ T-001 死代码清理
- ✅ T-002 cwb/autoCharCard 加入迁移
- ✅ T-003 NCCS 透传 customParams
- ✅ T-004 hint panel 点击插入

### GPT 或 Claude 都可以

- T-005 vendor 检查迁移（量大但机械）
- T-006 slider informational 状态
- T-009 JSON formatter

### 建议留给 Claude 或人

- T-007 mutations.js 抽出（涉及 IAD 一致性）
- T-008 Bus tool-call 升级（架构核心）
- T-010 ToolCall formatter（依赖前置）
- T-011 表格 Phase 0 收尾（filler 重复代码 dedup 风险高）

---

## 四、未列入但可能的小项

- 自动迁移完成后给所有 chat 类型 slot 加默认 link 选项（不只 tableFilling）
- profile 分配 UI 加"复用现有 profile"快捷按钮（避免用户为每个 slot 重复创建相同配置）
- 51TODO.md 第三节决策点中"是否合并发版"等问题做最终决定记录
- TODO.md（旧版本变更日志）的 v2.2.0 版本条目补全
