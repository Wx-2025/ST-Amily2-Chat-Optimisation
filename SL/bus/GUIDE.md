# Amily2Bus 开发者实战指南

> 本文档面向 Amily2 扩展的维护者与协作开发者，介绍如何在实际业务中使用总线系统。
> API 参考请查阅同目录下的 [README.md](./README.md)。

---

## 一、总线是什么？为什么用它？

Amily2Bus 是一个 **服务注册与发现** 系统。它解决的核心问题：

- **解耦循环依赖** — 模块之间不再需要互相 import，只需通过总线 `query()` 按名字查找
- **身份隔离** — 每个插件注册后拿到专属上下文（Capability Token），日志自动标注来源，文件存储自动隔离
- **可选依赖** — 查询不到服务不会崩溃，只返回 `null`，适合渐进式集成

**一句话理解**：`register()` = 我是谁，`expose()` = 我能做什么，`query()` = 我要找谁帮忙。

---

## 二、注册一个新服务（3 步）

### Step 1：注册身份

```javascript
// 在你的模块顶层（文件加载时执行）
let _ctx = null;

if (window.Amily2Bus) {
    try {
        _ctx = window.Amily2Bus.register('MyService');
        _ctx.log('Init', 'info', 'MyService 已上线。');
    } catch (e) {
        console.warn('[MyService] Bus 注册失败（可能是热重载导致重复注册）:', e);
    }
}
```

> **注意**：每个名字只能注册一次（严格锁）。热重载时会抛异常，用 try-catch 包住即可，页面刷新后会重置。

### Step 2：暴露能力

```javascript
// 把你希望其他模块能调用的函数暴露出去
_ctx.expose({
    doSomething,           // 暴露已有函数
    getStatus: () => 'ok', // 也可以内联
});
```

暴露后的对象会被 `Object.freeze()`，外部无法篡改。

### Step 3：完成

其他模块现在可以通过 `window.Amily2Bus.query('MyService')` 找到你暴露的方法了。

### 受限服务调用

`query()` 适合只读或不需要调用者身份的公共能力。涉及表格写入、权限或所有权时，服务应使用受限接口：

```javascript
// 提供方：只有已注册服务能通过 callService 调到这些方法。
ctx.exposeService({
    changeOwnedData({ caller }, payload) {
        // caller 由 Bus 注入，不能由调用参数伪造。
    },
});

// 调用方：使用自己注册时拿到的 capability context。
await ctx.callService('TableSystem', 'mutateOwnedRecord', {
    tableId: 'example.records',
    action: 'insert',
    values: { name: '示例' },
});
```

受限接口不会出现在 `query()` 返回的公共对象中。不要把 `caller` 作为普通参数传递，否则所有权检查可以被伪造。

---

## 三、调用其他服务

```javascript
const superMemory = window.Amily2Bus.query('SuperMemory');
if (superMemory) {
    await superMemory.awaitSync();
}
```

**关键原则**：总是做 `null` 检查。服务可能未加载、未注册、或被禁用。

### 项目中已注册的服务一览

| 服务名 | 用途 | 主要暴露方法 |
|---|---|---|
| `NccsApi` | NCCS 网络通道 | `call(messages, options)`, `getSettings()` |
| `MessagePipeline` | 消息处理管线 | `execute(pipelineCtx)` |
| `SuperMemory` | 超级记忆系统 | `initialize()`, `forceSyncAll()`, `awaitSync()`, `pushUpdate()`, `purge()` |
| `TableSystem` | 表格系统 | `processMessageUpdate()`, `fillWithSecondaryApi()`, `generateTableContent()`, `renderTables()` |
| `TavernHelper` | ST 操作封装 | 25+ 方法（聊天、世界书、角色卡等） |
| `LoreService` | 世界书读写锁 | `withLoreLock()`, `loadBook()`, `ensureBook()`, `saveBook()` |
| `Config` | 配置管理 | `get()`, `set()`, `getSettings()`, `migrate()` |
| `ApiProfiles` | API 配置文件管理 | Profile CRUD + 密钥管理 |
| `ApiKeyStore` | API 密钥安全存储 | `getKey()`, `setKey()` |
| `PUBLIC` | 系统元信息 | `getAvailableModules()`, `getRegisteredPlugins()`, `ping()` |

> 使用 `window.Amily2Bus.query('PUBLIC').getAvailableModules()` 可在控制台实时查看所有已暴露服务。

---

## 四、使用上下文的三大能力

注册后拿到的 `ctx` 对象提供三种开箱即用的能力：

### 4.1 日志（ctx.log）

```javascript
ctx.log('ModuleName', 'info', '这是一条日志');
// 输出: [14:32:01] [MyService::ModuleName] [INFO]: 这是一条日志
```

级别：`debug` / `info` / `warn` / `error`

调试时可在控制台动态开启某个服务的 debug 级别：
```javascript
window.Amily2Bus.Logger.setLevel('MyService', 'all');
```

### 4.2 文件存储（ctx.file）

基于 IndexedDB 的虚拟文件系统，按服务名自动隔离。

```javascript
await ctx.file.write('cache/data.json', { key: 'value' });
const data = await ctx.file.read('cache/data.json');
const files = await ctx.file.list();        // 列出本服务所有文件
await ctx.file.delete('cache/data.json');
await ctx.file.clearAll();                  // 清空本服务所有文件
```

> 路径禁止使用 `..`，系统会做安全校验。

### 4.3 网络请求（ctx.model）

统一的 AI 模型调用接口，支持直连和 ST 预设两种模式。

```javascript
const { Options } = ctx.model;

// 直连模式
const opt = Options.builder()
    .setMode('direct')
    .setApiUrl('https://api.example.com/v1')
    .setApiKey('sk-...')
    .setModel('claude-sonnet-4-20250514')
    .setMaxTokens(4096)
    .setTemperature(0.7)
    .setFakeStream(true)   // 防 CloudFlare 524 超时
    .build();

const reply = await ctx.model.call(messages, opt);

// ST 预设模式
const presetOpt = Options.builder()
    .setMode('preset')
    .setPresetName('MyProfile')
    .build();

const reply2 = await ctx.model.call(messages, presetOpt);
```

> **为什么用 ctx.model 而不是直接 fetch？**
> - 自动处理 FakeStream 防超时
> - 自动处理 ST 后端代理路由
> - 日志自动关联到你的服务名
> - 统一的错误处理与响应解析

### 4.4 工具调用 / Function Calling（ctx.tool + callWithTools）

让模型直接调用你定义的函数，而非吐自定义文本格式让你手写解析器。实测：用 tool_calls 输入仅增加约 200 token 的工具描述，但输出 token 常**直接减半**，串表/格式错乱也显著减少。

**两步：定义工具 → 跑 agent loop。**

```javascript
const ctx = window.Amily2Bus.register('MyService');

// Step 1：定义工具（本插件私有，其他插件看不到）
ctx.tool.define(
    'get_weather',
    {
        description: '查询某城市的当前天气',
        parameters: {
            type: 'object',
            properties: { city: { type: 'string', description: '城市名' } },
            required: ['city'],
        },
    },
    async ({ city }) => {              // handler：返回值会被自动回喂给模型
        return await fetchWeather(city);
    },
);

// Step 2：带工具跑 agent loop
const opt = ctx.model.Options.builder()
    .setApiUrl('https://api.example.com/v1')
    .setApiKey('sk-...')
    .setModel('gpt-4o')
    .build();

const result = await ctx.model.callWithTools(
    [{ role: 'user', content: '北京今天天气怎么样？' }],
    opt,
    { maxSteps: 8, onToolError: 'feedback' },
);

console.log(result.content);       // 模型的最终文字答复
console.log(result.toolCalls);     // 本次所有工具调用记录 [{ name, args, result }]
console.log(result.finishReason);  // 'stop'（正常结束）| 'maxSteps'（触顶）
```

**循环自动做的事**：拼装本插件 `define` 的全部工具 → 模型返回 `tool_calls` → 串行 dispatch 到对应 handler → 把返回值以 `role:'tool'` 回喂 → 进入下一轮，直到模型给出文字答复（不再调工具）或触顶 `maxSteps`。

**工具管理 API**：

```javascript
ctx.tool.define(name, { description, parameters }, handler);  // 定义/覆盖
ctx.tool.undefine(name);   // 移除单个工具
ctx.tool.list();           // 列出本插件已定义的工具名
```

**`callWithTools` 选项**：

| 选项 | 默认 | 说明 |
|---|---|---|
| `maxSteps` | `8` | 最多模型轮次，防 handler↔模型 死循环 |
| `onToolError` | `'feedback'` | handler 抛错时：`'feedback'` 把错误当工具结果回喂让模型自纠；`'throw'` 直接抛出 |
| `transport` | `'auto'` | 运输方式：`'tools'` 原生 function calling；`'json'` 工具说明进 prompt、模型吐协议 JSON；`'auto'` 先 tools、被拒自动降级 json 续跑 |
| `tools` | `[]` | 额外工具 schema（与 `define` 的合并，按名去重）；一般用不到 |
| `toolChoice` | `'auto'` | `'auto'`/`'none'`/`'required'` 或 `{ type:'function', function:{ name } }`（仅 tools 运输生效） |

**双运输机制（最大兼容性）**：同一份 `define` 的工具 schema 有两种走法——

- **tools 运输**：schema 进请求的 `tools` 字段，原生 function calling。输出 token 实测省约一半，**首选**。
- **json 运输**：schema 渲染进 system prompt，模型按协议吐 `{"tool_call":{"name","arguments"}}` 或 `{"final_answer":"..."}`（每轮单调用，可靠性优先）；工具结果以 `[TOOL_RESULT]` 文本回喂，不用 tool role。兼容**任何**能聊天的接口——包括禁用 tools 参数的中转站和 Claude/Gemini 原生接口。
- **auto（默认）**：先走 tools；请求被拒/响应异常时**自动降级 json 续跑同一轮**，日志记录降级。返回值的 `transport` 字段告诉你最终用的哪种。

插件作者无感知：工具只 define 一次、handler 只写一份，运输层自动切换。

> **handler 抛错怎么处理？** 默认 `'feedback'` 模式下，错误信息会作为工具结果回喂给模型——模型通常能据此自纠（换参数重试或改用文字回答）。这让"参数填错/表不存在"之类的问题自愈，而非整批失败。
>
> **接口兼容性**：两种常见的 tools "用不了"情形——① Claude、Gemini 的**原生**接口用的是不同的工具协议；② **不少中转站偷懒直接禁用了工具调用**，收到带 `tools` 的请求就拒。这两种都没法靠 URL 预判，只能失败时识别。默认 `'auto'` 下这不再致命：降级 json 运输续跑，功能不中断（多花些输出 token）。只有强制 `transport:'tools'` 时才会直接报错，且报错自动附上"部分中转站禁用了 tools 参数……"的可操作提示——建议插件 catch 后把 message 透传给用户。
>
> **与 `ctx.model.call()` 的区别**：`call()` 只返字符串、丢弃 tool_calls，适合纯文本生成；`callWithTools()` 走非流式 raw 路径、保留 tool_calls 并跑完整 loop。两者互不影响，按需选用。

---

## 五、常见模式与最佳实践

### 模式 1：可选依赖（推荐）

```javascript
// 好 — 查不到就跳过，不会崩溃
const memory = window.Amily2Bus.query('SuperMemory');
if (memory) {
    await memory.pushUpdate(charId, data);
}

// 坏 — 如果 SuperMemory 没注册就直接报错
const memory = window.Amily2Bus.query('SuperMemory');
await memory.pushUpdate(charId, data); // TypeError: Cannot read property 'pushUpdate' of null
```

### 模式 2：在 expose 中只暴露纯函数

```javascript
// 好 — 暴露的是明确的功能入口
ctx.expose({
    processMessageUpdate,
    fillWithSecondaryApi,
});

// 坏 — 不要暴露整个类实例或内部状态
ctx.expose({
    instance: this,          // 泄露内部状态
    _privateHelper: helper,  // 私有方法不该暴露
});
```

### 模式 3：热重载安全

开发中 SillyTavern 扩展可能被热重载，导致同名重复注册。始终用 try-catch：

```javascript
let _ctx = null;
if (window.Amily2Bus) {
    try {
        _ctx = window.Amily2Bus.register('MyService');
        _ctx.expose({ ... });
    } catch (e) {
        // 热重载时会走到这里，不影响功能
        console.warn('[MyService] 重复注册，跳过:', e.message);
    }
}
```

### 模式 4：跨服务协作（实际例子）

消息管线中，`super-memory-sync` 阶段需要等待 SuperMemory 同步完成：

```javascript
// core/pipeline/stages/super-memory-sync.js
async function execute(pipelineCtx) {
    const sm = window.Amily2Bus.query('SuperMemory');
    if (!sm) return; // SuperMemory 未加载，跳过此阶段

    await sm.awaitSync();
    // 继续管线后续逻辑...
}
```

表格系统更新后，通知 SuperMemory 同步变更：

```javascript
// core/table-system/manager.js
const sm = window.Amily2Bus.query('SuperMemory');
if (sm?.pushUpdate) {
    await sm.pushUpdate(characterId, updatedData);
}
```

---

## 六、调试技巧

### 控制台快速检查

```javascript
// 查看所有已注册的服务
window.Amily2Bus.query('PUBLIC').getRegisteredPlugins()

// 查看所有暴露了公共接口的服务
window.Amily2Bus.query('PUBLIC').getAvailableModules()

// 测试某个服务是否在线
window.Amily2Bus.query('NccsApi')  // 返回对象则在线，null 则未注册

// 开启某服务的全部日志
window.Amily2Bus.Logger.setLevel('TableSystem', 'all')

// 系统心跳
window.Amily2Bus.query('PUBLIC').ping()  // => 'pong'
```

### 日志级别控制

日志使用位掩码，可按需组合：

| 级别 | 值 | 说明 |
|---|---|---|
| `debug` | `0x1` | 调试信息（生产环境默认关闭） |
| `info` | `0x2` | 一般信息 |
| `warn` | `0x4` | 警告 |
| `error` | `0x8` | 错误 |
| `all` | `0xF` | 全部开启 |

```javascript
// 只看 warn + error
window.Amily2Bus.Logger.setLevel('MyService', 0x4 | 0x8);
// 或用字符串
window.Amily2Bus.Logger.setLevel('MyService', 'warn');
```

---

## 七、添加新功能模块的完整流程

假设你要新增一个「自动摘要」功能模块：

```
1. 创建文件 core/auto-summary/AutoSummaryService.js
2. 在文件中注册总线身份
3. 实现核心逻辑
4. 暴露需要被其他模块调用的方法
5. 在 index.js 中 import 该文件（确保它被加载）
```

```javascript
// core/auto-summary/AutoSummaryService.js
import { callNccsAI } from '../api/NccsApi.js';

let _ctx = null;

export async function summarize(text, maxLength = 200) {
    const messages = [
        { role: 'system', content: `请将以下内容压缩到${maxLength}字以内。` },
        { role: 'user', content: text }
    ];
    return await callNccsAI(messages);
}

// --- 总线注册 ---
if (window.Amily2Bus) {
    try {
        _ctx = window.Amily2Bus.register('AutoSummary');
        _ctx.expose({ summarize });
        _ctx.log('Init', 'info', 'AutoSummary 服务已就绪。');
    } catch (e) {
        console.warn('[AutoSummary] Bus 注册警告:', e);
    }
}
```

其他模块现在可以这样调用：
```javascript
const summary = window.Amily2Bus.query('AutoSummary');
if (summary) {
    const result = await summary.summarize(longText);
}
```

---

## 八、注意事项

1. **名字唯一** — `register()` 的名字是全局唯一的，确认不与已有服务冲突（参考上面的服务一览表）
2. **不要存引用** — `expose()` 的对象会被冻结，暴露的应该是函数而非可变状态
3. **加载顺序** — 总线在 `index.js` 的 `initializeAmilyBus()` 中初始化，所有服务通过 import 自动注册。如果你的模块依赖其他服务，在运行时 `query()` 即可，不需要控制 import 顺序
4. **`PUBLIC` 和 `Amily2` 是保留名** — 不要尝试注册这两个名字
5. **生产与开发** — 页面刷新会重置整个总线，不需要手动清理。热重载时的重复注册异常是预期行为，不影响功能
