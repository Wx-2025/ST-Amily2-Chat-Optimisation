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

---

## v2.2.5

### 修复

- **翰林院（RAG）API Key 污染**：
  - 修复 `saveSettingsFromUI` 无差别遍历翰林院面板内全部 `[data-setting-key]` 输入（包含被 `profile-sync` 接管隐藏的字段），导致掩码占位符 `••••••••` 被当作真值写回 `settings.rerank.apiKey` / `settings.retrieval.apiKey`，URL / model 也被 Profile 值覆盖到 legacy 字段。修复后会跳过祖先带 `data-profile-hidden` 的输入
  - `getRerankSettings` / `getEmbedRetrievalSettings` 同时加入防御性还原：识别历史污染留下的 `••••••••` 时归为空字符串，避免取消 Profile 分配后实际请求带占位符 token 被 401
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

---

## v2.2.8

### 新功能

- **填表记录 · 版本恢复**（填表设置面板「回退重填」旁新增「填表记录」按钮）：针对"模型填表前把整张表删空 / 误删大量内容"的反馈，提供一键找回。
  - **零新存储**：直接复用各楼层 `extra.amily2_tables_data` 里逐轮继承的表格快照——历史本就在聊天中，无需另建存储或元数据
  - 点开列出所有带快照的楼层（最新在上），可**展开预览**每一版的表格内容（CSV）后再决定
  - **恢复某版本**：把该楼层快照设为当前状态，并清除其**之后**所有楼层的快照与填表标记 hash——使该版本成为最新有效状态，后续楼层下轮自动重填会从恢复点往前重建（赌模型不再抽风）
  - 「回退重填」按钮保留，但版本恢复是更安全的找回路径

### 重构

- 抽出 `_normalizeTableState` 共用旧存档字段归一逻辑，`loadTables` 与"恢复快照"复用，消除重复

---

## v2.2.7

### 修复

- **分步填表 · 保留楼层场景下 swipe 最新楼会回退掉已填内容**：开启「保留楼层(bufferSize)」后，分步填表处理的是较早楼层、状态本应绑定到「被填楼层里最后一条」(E)。但 `updateTableFromText` / `updateTableFromOps` 在应用完操作后会**统一把表格状态写到聊天最新楼 L**，覆盖了随后 `markTargetsProcessed` 写到 E 的快照（`loadTables` 从尾部回溯先命中 L）。结果状态实际落在 L 上，**滑动/重新生成最新楼时 `rollbackState` 回退到上一轮快照，把本轮填入的内容一起丢掉、且因较早楼层的 hash 仍在而不再重填**。
  - 修复：给 `updateTableFromText` / `updateTableFromOps` 增加 `skipPersist` 选项；分步填表（文本 / Function Call / 手动应用三条 commit 路径）统一传入，跳过"写最新楼"，改由 `markTargetsProcessed` 把状态保存到 E。
  - `bufferSize=0`（默认）时 E 即最新楼，行为与旧版一致；仅 `bufferSize>0` 的保留楼层场景受影响并被修复。

---

## v2.2.6

### 新功能

- **翰林院向量化质量升级**：
  - **边界感知切块**：替换四个来源（聊天记录/小说/世界书/手动）的纯字符硬切——优先在段落边界断开，其次句末标点（含中文引号闭合），极端长串才硬切；句子/对话不再被拦腰截断，embedding 质量同步受益。仅影响新录入，已有向量无需重建
  - **注入时序重排**：检索结果注入提示词前按时序重排（聊天记录按楼层、小说按卷/章/节——中文数字章节号可解析），rerank 只决定"选哪些块"，不再决定呈现顺序；修复"不打不相识的剧情之后紧跟关系亲密"这类因按相关度排序导致的认知时间错乱
  - **断层提示**：聊天记录相邻块楼层跳跃时自动插入"与上文相隔约 N 楼，并非连续发生"提示行，消除中间剧情缺失造成的割裂感
  - **时间标识**：新录入的聊天记录块在来源标识中带上消息发送时间（ST 向量存储不持久化元数据，时间必须写入块文本才能在检索后取回；旧格式块兼容解析）
- **记忆块工作流（memory-blocks）**：剧情优化新增"自定义记忆块"体系——占位符驱动的并发工作流框架
  - 在剧情优化面板「匹配替换 (sulv)」下方可增删自定义块：每个块定义一个占位符，执行剧情优化时主/拦截提示词中的占位符会被块的产出替换
  - **静态块**：直接输出固定内容；**AI 调用块**：用所选 API 功能槽独立请求一次，把回复（或其中指定 `<标签>` 的内容）作为替换值
  - 原有 sulv1-4 速率占位符迁入同一框架，行为与旧版逐字节一致
  - 块定义为纯 JSON、随设置持久化，为后续导入导出与战斗系统接入预留扩展点
  - 框架层新增**顺序拼接式 Chain**（`composeChain`）：与占位符替换并列的第二种组合范式——同链的块并发执行后按 `order` 排序、以 `separator` 拼接并可选 `header/footer` 包裹，产出一个完整注入块；为记忆注入合成块与战斗系统"底部战报块"预留的承载结构，本版本暂无 UI 入口
- **渐进记忆（开发中功能，暂未对外开放）**：主菜单新增独立入口（点击提示"开发中，未来版本开放"），后续完善后放出。当前已落地的设计：
  - 按"近期完整、远期摘要"的时间梯度，从指定表格（默认总结表，行序旧→新）采样历史并注入上下文：最新 X 行全量保留 + 其余历史对半拆分，较近一半等距取 Y 行、较远一半等距取 Z 行（中心对齐等距采样，不随机、不首尾加权，避免内容扎堆或事件结局被规律性忽略）
  - 经 `setExtensionPrompt` 直接注入当回合上下文——内容独立、不写世界书、不随聊天/角色卡导出，生命周期天然跟随会话（区别于超级记忆的世界书条目路线）
  - 注入位置 / 深度 / 角色 / 模板（含 `{{progressive_memory}}` 占位符）均可在面板配置；采样参数 X/Y/Z 默认 5/5/3，全部纯 JSON 持久化
  - 采样器 `sampler.js` 为纯函数，参数结构与 memory-blocks 工作链对齐，后续可平移为 `progressive_sample` 节点
- **超级记忆 · 首行常驻**（表格专属配置新增开关，默认关闭）：表格第一行通常是总调/全局定义行（基调、主线目标等），原先与普通行一样走绿灯——没人提到主键就永远不注入；开启后该行详情条目升为蓝灯常驻，切换即时生效
- **API 连接配置**：
  - 角色世界书（cwb）与一键生卡（autoCharCard）纳入旧配置自动迁移：老用户首次加载会把旧 URL / Key / 模型自动迁移为连接配置并分配槽位（一键生卡仅在规划者与执行者配置一致或规划者为空时迁移，避免悄悄改变行为）
  - **profile 已分配时参数控件 informational 化**：主面板 / 并发剧情优化 / 角色世界书 / 术语表的温度、maxTokens 控件在槽位分配 profile 后自动禁用并显示"由连接配置控制"提示，消除"改了没效果"的用户陷阱
  - **profile 状态卡新增"本设备无 Key"警示**：API Key 仅保存在最初填写它的设备/浏览器上（安全设计，不随云端设置同步），换设备后状态卡会直接亮出警示徽标，不必等到调用报错才发现

### 修复

- **独立聊天记忆从摆设变真功能**：此前向量数据"随卡不随聊天"——开启"独立聊天记忆"后录入仍存进角色库、查询却去查一个从未被写入过的聊天集合、计数恒为 0，整体静默失效。现已重构为聊天级分桶：
  - 独立模式下，聊天记录类向量按当前聊天隔离存储与检索，同一张卡开多个聊天（不同剧情线）的记忆互不污染
  - 小说 / 世界书 / 手动录入属于"知识"，仍随角色卡跨聊天共享；全局库不受影响
  - 知识管理列表为聊天专属库显示"聊天级"徽标；聊天级库禁止移动到全局
  - 统一模式（默认关闭独立记忆）的存量数据与行为完全不变
  - 已知限制：聊天专属记忆跟随聊天文件，重命名聊天文件会使其失联（与 ST 官方向量扩展同等限制）
- **超级排序截断顺序修正**：开启"超级排序"时，时序重排发生在 top_n 截断之前，导致保留的是"时序最早"而非"最相关"的块，检索结果长期偏向最旧的聊天记录。现改为先按相关度截取 top_n、再做时序排序
- **翰林院向量化失败（"向量化块数量不识别"反馈）**：
  - 一次性清洗 profile-sync 历史污染：`retrieval/rerank.apiKey` 中的掩码占位符在持久层根治（此前仅读取侧防御）；`apiEndpoint` / `rerank.apiMode` 的非法值（如被旧版写入的空字符串）归一化为 `custom`
  - 修复 `apiEndpoint` 为空/非法时请求被硬定向到 `api.openai.com`、无视用户自定义 URL 的问题（CSP 拦截 / 401 的元凶）
  - 修复**本地代理（LM Studio/Ollama）模式**自始就缺少 URL 分支、同样被错误定向到 openai.com 的问题
  - API 模式下拉补全 `OpenAI 官方` / `Azure` 选项；默认 API 模式改为 `custom`（与默认 URL 配套），新用户不再因选项缺失导致首次保存写入空值
  - profile-sync 给下拉框赋不存在选项值的污染源头修复（影响所有模块面板，不止翰林院）
- **Rerank "测试成功但实际请求报 API Key 未提供"（路径分叉根因）**：实际重排调用 `executeRerank(query, docs, settings.rerank)` 直接把 legacy 嵌套设置当连接传入，绕过了 `getRerankSettings()` 的 profile 解析；而「测试连接」传 `null` 会正常解析 profile——于是用 API Profile 配 rerank 的用户测试通过、实际生成时却拿到空 apiKey/stale url 报错。现实际调用点统一走 `getRerankSettings()`（profile 优先、legacy 兜底），与测试路径一致；`enabled / notify / hybrid_alpha` 等行为开关仍读 legacy 设置
- **Rerank "API Key 未提供"报错升级**：当原因是"连接配置在本设备没有可用 Key"时，报错会直接说明 Key 的设备本地性并指引到 API 连接配置重新填写（向量化 Google 直连、获取模型列表同步处理）
- **旧配置迁移**：一键生卡迁移时排除掩码占位符，避免把历史污染的假 Key 迁入新连接配置
- **超级记忆稳定性专项**（针对"工作不大稳定"反馈，4 处根因一次修复）：
  - **切聊天竞态污染**：CHAT_CHANGED 时超级记忆立即全量同步，而表格系统延迟 100ms 才加载新聊天的表格，导致【旧聊天】的表格内容被写进【新角色】的记忆世界书；两边表名不同时旧表条目无 GC 兜底会**永久残留**（"记忆串台"元凶）。现 CHAT_CHANGED 只确保世界书存在，新状态同步交由 `loadTables()` 完成后的自动推送，单次且时序正确
  - **死代码双轨存储拆除**：`saveStateToMetadata` / `tryRestoreStateFromMetadata` 把表格状态写到 `msg.metadata`——该字段非 ST 持久化位（同 v2.2.5 二次填表修过的坑），写入即蒸发、恢复永远为空，且每次同步还白调一次 `saveChat()`。整条链路删除，表格状态唯一信源为表格系统的 `msg.extra.amily2_tables_data`
  - **`awaitSync()` 穿透**：同步队列正忙时 `pushUpdate` 会用一个立即 resolve 的空 Promise 覆盖 `_syncPromise`，Pipeline Stage 4 等待形同虚设、后续阶段在同步未完成时被放行。现忙时不覆盖，正在运行的 drain 循环自然吃掉新入队项
  - **开关打开不生效**：启动时若总开关为关，初始化早退且不注册监听器；此后在 UI 勾选开关只写设置，超级记忆直到刷新页面前都是死的。现勾选即触发初始化（幂等）
  - 附带：`forceSyncAll` 的表格角色推断改为复用 `events-schema.inferTableRole`，消除两处重复逻辑漂移风险；每次切聊天的双倍全量同步（restore 路径一次 + 显式一次）随死代码移除归一

### 重构

- 表格核心 `manager.js` 瘦身（约 1050 → 600 行）：19 个 UI 突变操作拆分至 `actions/ui-mutations.js`，SuperMemory 事件分发拆分至 `events-dispatch.js`；全部经 re-export 保持兼容，外部调用路径零改动
- 角色世界书最后 2 处散乱的厂商 URL 判断迁移至 `detectVendor` 统一入口，业务路径上不再有硬编码的 URL substring 判断
