# Amily2Bus 开发者实战指南

> 本文档面向 Amily2 扩展的维护者与协作开发者，介绍如何在实际业务中使用总线系统。
> API 参考请查阅同目录下的 [README.md](./README.md)。

---

## 一、总线是什么？为什么用它？

Amily2Bus 是一个 **服务注册与发现** 系统。它解决的核心问题：

- **解耦循环依赖** — 模块之间不再需要互相 import，只需通过总线 `query()` 按名字查找
- **命名空间隔离** — 每个插件注册后拿到绑定名称的上下文，日志自动标注来源，文件存储自动隔离
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
// 提供方：接口不会出现在 query() 结果中，只能通过注册上下文调用。
ctx.exposeService({
    changeOwnedData({ caller }, payload) {
        // caller 由 Bus 按当前注册上下文注入。
    },
});

// 调用方：使用自己注册时拿到的 capability context。
await ctx.callService('TableSystem', 'mutateOwnedRecord', {
    tableId: 'example.records',
    action: 'insert',
    values: { name: '示例' },
});
```

受限接口不会出现在 `query()` 返回的公共对象中。`caller` 适合合作式模块的命名空间和所有权判断，但不是同一页面敌对脚本之间的认证凭据；外部插件名称仍属于不可信输入。Amily 内建名称已从公共 `register()` 中保留，避免最直接的抢注覆盖。

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
| `NccsApi` | NCCS 脱敏状态 | `getStatus()` |
| `MessagePipeline` | 消息处理管线状态 | `getStatus()` |
| `SuperMemory` | 超级记忆同步状态 | `getStatus()`, `awaitSync()` |
| `TableSystem` | 表格只读查询 | `listTables()`, `getTableSnapshot()`, `queryRecords()` |
| `TavernHelper` | ST 助手状态 | `getStatus()` |
| `LoreService` | 世界书服务状态 | `getStatus()` |
| `Config` | 配置模块状态 | `getStatus()` |
| `ApiProfiles` | API 配置只读摘要 | `getProfiles()`, `getProfile()`, `getAssignment()` |
| `ApiKeyStore` | API 密钥存储状态 | `getStatus()` |
| `PUBLIC` | 系统元信息 | `getAvailableModules()`, `getRegisteredPlugins()`, `ping()` |

> 使用 `window.Amily2Bus.query('PUBLIC').getAvailableModules()` 可在控制台实时查看所有已暴露服务。

---

## 四、使用上下文能力

注册后拿到的 `ctx` 对象提供日志、隔离文件、公开接口注册和非公开服务调用能力。全局 Bus 不提供模型或工具执行能力。

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

### 4.3 模型调用不属于公共 Bus

`window.Amily2Bus` 对所有同页脚本可见。若在注册上下文中提供 `model.call()`，任意脚本都能把用户配置的连接当作无预算推理代理。因此以下能力被明确禁止：

- 读取或写入 API Key；
- 返回完整连接配置或认证头；
- 接受任意消息并代为调用模型；
- 允许调用者覆盖端点、Key、请求头或预算。

Amily 内部功能通过模块导入使用自身受控调用路径。未来若向外部模块开放模型任务，只能通过带用途、预算、并发、取消和审计约束的任务代理实现。

### 4.4 工具与模型任务

公共注册上下文没有 `ctx.tool`。工具定义、handler 和模型 agent loop 必须留在 Amily 内部模型任务代理中，并在任务级声明用途、最大模型轮次、Token 预算、并发上限、取消信号及审计字段。外部插件需要联动时，应调用目标模块显式公开、经过约束的领域方法。

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
    getStatus,
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
window.Amily2Bus.query('NccsApi')?.getStatus()

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

新模块应只公开无需秘密、无需用户授权的最小领域能力：

```javascript
function getStatus() {
    return Object.freeze({ ready: true, version: 1 });
}

if (window.Amily2Bus) {
    try {
        const ctx = window.Amily2Bus.register('MyFeature');
        ctx.expose({ getStatus });
        ctx.log('Init', 'info', 'MyFeature 服务已就绪。');
    } catch (error) {
        console.warn('[MyFeature] Bus 注册警告:', error);
    }
}
```

需要模型、凭证、聊天写入或世界书写入的新功能，不得照此直接公开执行函数；应先建立对应的受控领域服务和授权边界。

---

## 八、注意事项

1. **名字唯一** — `register()` 的名字是全局唯一的，确认不与已有服务冲突（参考上面的服务一览表）
2. **不要存引用** — `expose()` 的对象会被冻结，暴露的应该是函数而非可变状态
3. **加载顺序** — 总线在 `index.js` 的 `initializeAmilyBus()` 中初始化，所有服务通过 import 自动注册。如果你的模块依赖其他服务，在运行时 `query()` 即可，不需要控制 import 顺序
4. **`PUBLIC` 和 `Amily2` 是保留名** — 不要尝试注册这两个名字
5. **生产与开发** — 页面刷新会重置整个总线，不需要手动清理。热重载时的重复注册异常是预期行为，不影响功能
