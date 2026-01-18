# Amily2Bus (Amily2 总线系统)

Amily2Bus 是 Amily2-Chat-Optimisation 插件系统的核心基础设施。它为所有子模块和外部插件提供了一个规范化、安全且高兼容性的运行环境。

## 核心特性

- **安全控制台 (SafeConsole)**: 通过 Iframe 逃生通道获取纯净 Console 引用，绕过 SillyTavern 等环境的日志劫持。
- **能力令牌 (Capability Token)**: 插件注册后获取专属上下文，自动绑定身份，实现日志追踪与文件隔离。
- **防超时网络层 (FakeStream)**: `ModelCaller` 支持伪流式聚合，通过持续保持 TCP 连接活跃，彻底解决 CloudFlare 524 超时问题。
- **位运算日志系统**: 基于位掩码的日志级别控制，支持针对特定插件或模块动态调整输出粒度。
- **异步责任链**: 预置 `Chain` 模块，支持插件化的异步中间件处理流程。

---

## 快速开始

### 1. 初始化

总线通常在系统启动时自动挂载到 `window.Amily2Bus`。

```javascript
import { initializeAmilyBus } from './SL/bus/Amily2Bus.js';
initializeAmilyBus();
```

### 2. 插件注册

所有插件必须注册以获取专属上下文：

```javascript
const amily = window.Amily2Bus.register('MyAwesomePlugin');
```

---

## 模块说明

### 1. 标准日志 (Logger)

支持 `debug`, `info`, `warn`, `error` 四个级别。

```javascript
// 自动绑定插件名，输出格式: [时间] [MyAwesomePlugin::Main] [INFO]: 消息内容
amily.log('Main', 'info', '插件已就绪');
```

### 2. 网络请求 (ModelCaller & Options)

统一处理 API 调用，支持自动切换 ST 配置文件 (Profile) 及防超时处理。

```javascript
const { Options } = amily.model;

const opt = Options.builder()
    .setMode('direct')           // 'direct' (直连) 或 'preset' (ST预设)
    .setFakeStream(true)        // 开启伪流式聚合，防止 524 超时
    .setApiUrl('...')
    .setApiKey('...')
    .setModel('gpt-4o')
    .build();

const result = await amily.model.call(messages, opt);
```

### 3. 文件操作 (FilePipe)

提供基于插件命名的虚拟文件系统隔离，防止插件间非法访问。

```javascript
// 写入文件 (自动定位到 /virtual_fs/MyAwesomePlugin/config.json)
await amily.file.write('config.json', { theme: 'dark' });

// 读取文件
const data = await amily.file.read('config.json');
```

### 4. 责任链 (Chain)

用于处理复杂的、可扩展的异步逻辑流。

```javascript
import { Chain } from './SL/bus/chain/Chain.js';

const pipeline = new Chain();
pipeline.use(async (ctx, next) => {
    ctx.data += " -> 步骤1处理";
    await next();
});

const context = { data: "开始" };
await pipeline.execute(context);
```

---

## 目录结构

- `Amily2Bus.js`: 总线入口，协调各模块。
- `log/Logger.js`: 位运算日志管理器。
- `file/FilePipe.js`: 安全文件操作管道。
- `api/ModelCaller.js`: 核心 API 调用器。
- `api/Options.js`: API 请求配置构建器。
- `chain/Chain.js`: 异步责任链工具。

---

## 开发规范

1. **强制类型**: `model.call` 必须接收 `Options` 类的实例，建议始终使用 `Options.builder()` 构建参数。
2. **路径安全**: 使用 `file` 接口时，禁止在路径中使用 `..` 等跳转符，系统会自动进行安全校验。
3. **日志分级**: 生产环境默认屏蔽 `debug` 级别，调试时可通过 `window.Amily2Bus.Logger.setLevel('PluginName', 'all')` 动态开启。
