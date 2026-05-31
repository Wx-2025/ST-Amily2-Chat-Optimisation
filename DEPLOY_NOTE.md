# 部署更新日志

每个版本块格式：`## v{version}`，Jenkins 构建时自动提取对应块作为 GitHub 提交说明。

---

## v2.2.2

### 新功能

- **Function Call 填表模式**：在填表设置中新增独立开关，启用后支持通过 OpenAI 兼容接口（DeepSeek / OpenRouter / 各类中转等）直接返回结构化操作列表，绕过 `<Amily2Edit>` 文本解析路径，填表更稳定
  - 遇到不支持 `tool_choice` 的接口时自动降级重试
  - 对思考模型注入强制调用指令，防止绕过工具直接输出文本
  - 全部走 ST 后端代理，修复 CSP 拦截直连外部 URL 的问题
- **主界面新增提示词链编辑器入口**，同时调换了记忆管理与角色世界书的按钮位置
- **规则中心**新增"自动排除用户楼层"选项

### 修复

- 提示词链按钮点击无响应（改为事件委托方式绑定）
- 拖拽组件微抖误触发（加 5px 移动阈值过滤）
- 填表检查窗若干问题修复；翰林院（批量回填）修复；防抖逻辑落地
- 角色世界书入口添加使用警告弹窗（强制 10 秒倒计时），提示该功能长期未维护
- ApiProfile `fakeStream` 字段保存丢失问题
- 正文优化默认改为关闭状态
- NGMS / NCCS API 配置槽位标签修正（NGMS→总结，NCCS→填表）
- API Profile 面板选择逻辑统一重构，修复多处旧字段覆盖新配置的问题
- 世界书控制参数兼容性修复（排除递归、插入位置、扫描深度等，适配 ST 1.17.0+）

---

## v2.2.3

### 新功能

- Function Call 填表开关下方新增公益站风险提示横幅：部分公益站会屏蔽 tools 参数，请确认支持情况避免被意外封禁

### 修复

- **Function Call 填表**：
  - 修复 ST 代理以 HTTP 200 + error body 形式返回错误、导致降级重试机制从未触发的问题
  - 修复思考模式模型（如 DeepSeek v4-flash）因 tool_choice 不兼容返回 Bad Request 后正确降级并重试
  - 重试时自动追加强制调用指令，防止思考模型绕过工具直接输出文本造成无效二次开销
- **超级记忆 / 翰林院**：
  - 修复 `getRagSettings()` 读写顶层路径而非嵌套路径，导致打开超级记忆面板后向量化、归档等开关在重载时被全默认值覆盖的问题
  - 修复自动归档失效问题
  - 修复归档管理器在同一事件中被三次触发的回归问题
  - 修复翰林院设置旧版迁移逻辑异常

---

## v2.2.4

### 新功能

- **Function Call 填表**：
  - FC 首次请求时对 DeepSeek 系模型自动附加 `thinking: { type: "disabled" }`，避免思考模式与 tool_choice 冲突
  - 操作列表为空时在日志面板输出原始响应 JSON，便于区分"AI 判断无需变更"、"格式校验全部不通过"和"JSON 解析失败"三种情况

### 修复

- **剧情优化**：移除剧情优化页面遗留的 Jqyh 直连配置字段（URL / Key / Model），统一走 API 连接配置功能分配槽位
- **表格**：
  - 补全 `batch-filling-threshold` 批处理阈值的持久化绑定（页面刷新后不再还原为默认值 30）
  - 修复分步填表并发锁与 async/await 时序问题
  - 修复外层多余 `try...finally` 导致的插件加载报错
- **Rerank**：
  - 修复选择连接配置后报"API Key 未配置"的问题（`apiMode` 现从设置读取而非硬编码 `custom`）
  - 补全 `hly-rerank-api-mode` 加载绑定及默认值
- **翰林院 RAG**：补全 `priorityRetrieval.sources` 各来源条目的缺失键，修复设置面板回填 TypeError
- **二次填表**：
  - 修复 `secondary-filler.js` 把哈希/重试次数写入非持久化的 `msg.metadata` 字段（ST 标准位是 `msg.extra`），导致刷新后去重与重试计数失效
  - 修复扫描深度重复计入 `bufferSize`（`contextLimit + buffer + batch + redundancy` → `contextLimit + batch + redundancy`），避免越过预期窗口
  - SWIPED 事件改走扫描路径，不再用 `targetMessage` bypass 强填最末条，`保留缓冲区(bufferSize)` 设置在滑动场景下正确生效（手动"回退重填"按钮仍保留 bypass，意图明确）
  - 修复 FC（Function Call）路径下成功填表与"AI 判断无需修改"两种结果均未写回 `amily2_process_hash` 与 `saveChat()` 的问题——之前导致 FC 模式去重完全失效，最旧的未处理楼层会被每次扫描重复发给 AI；现统一回写路径为 `markTargetsProcessed`
  - FC 空操作时同步输出原始响应 JSON 到控制台（与批量回填日志面板保持一致），便于区分"无需变更"/"格式校验失败"/"JSON 解析失败"
  - 修复 `fillWithSecondaryApi` 入口处过早设置 `secondaryFillerRunning = true`，导致防抖/总开关关闭/聊天过短/非分步模式/系统瘫痪五条早返路径均不解锁的死锁问题（特别是防抖路径——锁住后 setTimeout 回调撞上自己的锁，永久跳过后续触发）。锁的获取已挪到所有早返检查之后、`try` 块之前
- **填表设置面板**：新增"手动解除填表锁"按钮（位于触发延迟下方），用于兜底应急——若仍遇到"分步填表正在进行中，跳过本次触发"反复刷屏，可手动点击释放
- **API 调用层全面支持 AbortController**（`callAI` / `callAIForTools` / `callNccsAI` 及其全部下游 provider）：
  - 新增 `options.signal` 透传，OpenAI 兼容 / OpenAI(测试) / Google 直连 / ST 后端 / FC 等所有 `fetch` 调用均接受 `AbortSignal`
  - `callSillyTavernBackend` 由 `$.ajax` 改写为 `fetch`，以原生支持 signal
  - `callSillyTavernPreset` / `callNccsSillyTavernPreset` 通过 `raceAgainstSignal` 兜底，外部不可终止的 `ConnectionManagerRequestService.sendRequest` 也能在 signal 触发时即时返回 AbortError
  - 全部 catch 块识别 `AbortError`，rethrow 而不弹错误 toast；FC 重试逻辑识别中断后跳过重试
- **填表设置面板**：在"手动解除填表锁"旁新增"强制中断当前填表"按钮——通过 AbortController 真正掐断 fetch 连接（fetch 立即抛错），结果会被丢弃，不会污染表格 / hash / `saveChat`
