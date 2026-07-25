# Amily2Bus (Amily2 总线系统)

Amily2Bus 是 Amily2-Chat-Optimisation 插件系统的核心基础设施。它为所有子模块和外部插件提供了一个规范化、安全且高兼容性的运行环境。

## 核心特性

- **安全控制台 (SafeConsole)**: 通过 Iframe 逃生通道获取纯净 Console 引用，绕过 SillyTavern 等环境的日志劫持。
- **绑定上下文**: 插件注册后获取绑定命名空间的上下文，实现日志追踪与文件隔离；它不被描述为同页面敌对代码间的认证令牌。
- **最小公共能力**: 全局 Bus 不提供凭证读取或通用模型执行，公共接口必须适合任意同页调用者。
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

### 2. 公共能力边界

`window.Amily2Bus` 可被同页脚本发现，因此注册上下文只提供日志、隔离文件和领域服务联动，不提供 `model.call()` 或工具注册/执行能力。

```javascript
const status = window.Amily2Bus.query('NccsApi')?.getStatus();
// 仅返回启用/配置状态，不返回 API Key、端点或模型调用函数。
```

需要模型能力的 Amily 内部模块必须使用受控模块导入；外部插件不得借 Bus 使用用户连接。

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

1. **秘密不公开**: 禁止通过 `expose()` 返回 API Key、认证头、完整连接配置或私钥材料。
2. **模型不代理**: 禁止通过公共 Bus 暴露通用 AI 调用函数；内部任务需走受控模型层。
3. **路径安全**: 使用 `file` 接口时，禁止在路径中使用 `..` 等跳转符，系统会自动进行安全校验。
4. **日志分级**: 生产环境默认屏蔽 `debug` 级别，调试时可通过 `window.Amily2Bus.Logger.setLevel('PluginName', 'all')` 动态开启。
