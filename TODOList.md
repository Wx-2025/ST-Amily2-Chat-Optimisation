# TODOList — 待办任务总览

> 用于派工与进度跟踪。任务卡格式统一，可拆分给不同执行者（人 / Claude / GPT / 其他模型）。
>
> 关联文档：
> - [51TODO.md](51TODO.md) — 跨方向重构计划（Bus tool-call 升级 / 跨议题决策点）
> - [TableTODO.md](TableTODO.md) — 表格模块 IAD 深度重构计划（Phase 0/B/C）
> - [TODO.md](TODO.md) — 旧版本变更日志（保留作为发布记录）
>
> 最后更新：2026-06-11，对应 v2.2.5+（2603 分支）。

---

## 一、最近落地（v2.2.0 → 当前）

> 上下文摘要，让接手者了解当前状态。代码细节看对应 commit。

| commit | 内容 | 涉及范围 |
|--------|------|--------|
| `d283ff4` | 表格模块 IAD 解耦 + API 自定义参数 + 厂商预设连接 | `core/table-system/*` dto/infra/actions；`assets/api-vendor-params.json`；UI |
| `671c1b2` | profile 优先级修正：profile 分配后即权威 | `core/api.js` 6 处 `getApiSettings` |
| `8b4b6b0` | 二级填表死锁修复 + 强制中断按钮（AbortController 贯穿） | `secondary-filler.js` |
| `dc57a1d` | memory-blocks Phase 1：占位符工作流抽象层，sulv1-4 迁入 | `core/memory-blocks/*`；`summarizer.js` |
| `91ceecc` | memory-blocks Phase 2：ai_call handler + 自定义块 UI 与持久化 | `core/memory-blocks/*`；剧情优化面板 |
| `6ad1354` | T-002：cwb / autoCharCard 纳入 legacy 自动迁移（迁移版本化 v2） | `ApiProfileManager.js` |
| `784bd70` | T-006：profile 已分配时参数控件 informational 化 | `ui/profile-slider-guard.js` + 4 面板 |
| `ef45e74` | T-007 / Phase 0.4：manager.js 抽出 ui-mutations + events-dispatch | `core/table-system/*` |

**核心架构现状**（接手必读）：

- **状态权威**：`utils/config/ApiProfileManager.js` 是 API 配置单一指挥所；profile 分配后即权威，旧字段不再覆盖 profile；legacy 迁移已版本化（`_legacyProfileMigrationVersion`，当前 v2 覆盖 8 个 chat slot）
- **表格模块**：核心在 [core/table-system/](core/table-system/)，IAD 拆分（dto/infra/actions/rendering.js/templates.js/preset.js/events-dispatch.js）；manager.js 已收缩至 ~600 行编排层，19 个 UI 突变在 [actions/ui-mutations.js](core/table-system/actions/ui-mutations.js)（manager re-export 兼容）
- **memory-blocks**：[core/memory-blocks/](core/memory-blocks/) 占位符驱动工作流，static + ai_call 两种 handler，自定义块 UI 在剧情优化面板；Phase 3（JSON 导入导出 / 战斗系统 plugin handler）未做
- **API 厂商识别**：[utils/api-vendor.js](utils/api-vendor.js) detectVendor 为单一入口，业务路径散乱 includes 已清零
- **VS Code 类型校验**：[jsconfig.json](jsconfig.json) checkJs 开启，[types/sillytavern.d.ts](types/sillytavern.d.ts) 提供全局声明

---

## 二、已完成任务（2026-06-11 核对）

| ID | 内容 | 状态 |
|----|------|------|
| T-001 | 死代码清理 | ✅ 3 处死绑定已删。**例外**：`core/fractal-memory.js` 刻意保留——非本人设计，原作者未弃坑，留作坑位，勿删 |
| T-002 | cwb / autoCharCard legacy 自动迁移 | ✅ `6ad1354`。cwb 实际字段为 snake_case（`cwb_api_url`）；autoCharCard 双角色嵌套对象，仅 planner 空/同 executor 时自动迁 |
| T-003 | NCCS 等支路透传 customParams | ✅ Nccs / Ngms / Jqyh / Sybd 四个 API 文件均已接入 |
| T-004 | hint panel 点击参数名插入 | ✅ `.amily2_param_hint_btn` + `_insertParamToCustomParams` |
| T-005 | 散乱 vendor URL 检查迁 detectVendor | ✅ `f7781c2` 收尾。保留项：`_detectVendorFromUrlSync`（迁移 IIFE 自包含）、RequestBody.js 兜底（即目标模式） |
| T-006 | profile 已分配时 slider informational | ✅ `784bd70`。范围：参数滑条（main / plotOptConc / cwb / sybd 四面板）；URL/Key/模型输入框见 T-012 |
| T-007 | manager.js 抽出 ui-mutations.js | ✅ `ef45e74`。含 events-dispatch.js 抽出；manager↔ui-mutations 运行时环留待 0.8 解 |

---

## 三、待办任务

### 🟡 中等任务

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

#### T-012: URL / Key / 模型输入框的 profile 压制提示（T-006 续）

- **类型**：feature / UX
- **难度**：🟡 中等
- **建议执行者**：GPT 或 Claude
- **依赖**：无（复用 [ui/profile-slider-guard.js](ui/profile-slider-guard.js)）

**背景**：T-006 只覆盖了参数滑条。各模块面板的 API URL / Key / 模型输入框在 profile 分配后同样失效，且涉及「测试连接 / 拉取模型」按钮的联动判断（这些按钮读的是 profile 还是 DOM 因模块而异），需逐面板核对后接入 `watchProfileSliderGuard`。

**验收**：
- [ ] profile 分配后各面板 URL/Key/模型输入框 disable + 提示
- [ ] 测试连接按钮行为与提示一致（测的是 profile 配置就保持可用）

---

#### T-013: 剧情优化面板 top_p / presence / frequency 输入为死配置

- **类型**：bug / cleanup
- **难度**：🟡 中等（需决策）
- **建议执行者**：Human 决策 + 任意执行
- **依赖**：无

**背景**：`plotOpt_top_p` / `plotOpt_presence_penalty` / `plotOpt_frequency_penalty` 只有 UI 在读写（[plot-opt-bindings.js](ui/plot-opt-bindings.js)），core 请求路径无人消费——用户改了完全没效果。二选一：
1. 接上：在 plotOpt 请求体里带上这三个参数（profile 的 customParams 机制已能覆盖此需求，可能多余）
2. 删掉：移除 UI 控件 + 默认值 +（已在 clearLegacyConfig 列表中）

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
- **依赖**：T-007 已完成 ✅，可随时开工

**详见**：[TableTODO.md#四-phase-0](TableTODO.md) 0.7-0.9

- 0.7: `core/table-system/filler/shared.js` —— 三个 filler 重复代码消除
- 0.8: 解循环依赖（manager ↔ secondary-filler；新增的 manager ↔ ui-mutations 一并处理）
- 0.9: TableSystemService 真正变成门面

**预估**：1 天

---

#### T-014: memory-blocks Phase 3

- **类型**：feature
- **难度**：🟡 中等
- **建议执行者**：Claude
- **依赖**：Phase 2 已完成 ✅（`91ceecc`）

**核心交付**：
- 自定义块 JSON 导入导出（`replaceContextBlocks` 已就位）
- 战斗系统通过 `plugin` handler 接入（types.js 契约已预留）
- summarizer 链路补 AbortController，让 ai_call 块可中断（handler 的 signal 透传已就位）

---

## 四、派工建议

### GPT 或 Claude 都可以

- T-009 JSON formatter
- T-012 URL/Key informational（机械，照 T-006 模式）

### 建议留给 Claude 或人

- T-008 Bus tool-call 升级（架构核心）
- T-010 ToolCall formatter（依赖前置）
- T-011 表格 Phase 0 收尾（filler dedup 风险高）
- T-013 死配置决策（需 Human 拍板接上还是删掉）
- T-014 memory-blocks Phase 3

---

## 五、未列入但可能的小项

- 自动迁移完成后给所有 chat 类型 slot 加默认 link 选项（不只 tableFilling）
- profile 分配 UI 加"复用现有 profile"快捷按钮（避免用户为每个 slot 重复创建相同配置）
- 51TODO.md 第三节决策点中"是否合并发版"等问题做最终决定记录
- TODO.md（旧版本变更日志）的 v2.2.x 版本条目补全
