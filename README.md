# dsh-agent-core-plugins

把 [kernel4632/agent-core](https://github.com/kernel4632/agent-core) 里几处好用的机制，
移植成 DeepSeek Harness（DSH）插件的两个独立包。

不是搬库，是补差集：agent-core 的循环、会话、工具管线 DSH 本来就有，
这里只取 DSH 缺的三件事——**目录即工具**、**总结升格 system**、**空谈追问**。

| 包 | 作用 | 状态 |
|---|---|---|
| [`dsh-ac-tools`](./dsh-ac-tools) | 往目录里丢 `.mjs` 就多一个模型工具，执行在隔离子进程 | 实测运行 |
| [`dsh-ac-compaction`](./dsh-ac-compaction) | 压缩总结注入 system + 指令增强引擎 + 空谈追问 | 实测运行（DSH 0.2.1-rc.3） |

## 安装

DSH 的 profile 目录（桌面端默认 `%USERPROFILE%\.dsh\profiles\desktop`）里做两件事。

**1. 链接源码**（也可以直接 `git clone` 进 `node_modules/@local/`）：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Directory -Force node_modules\@local | Out-Null
New-Item -ItemType Junction -Path node_modules\@local\dsh-ac-tools       -Target <本仓库路径>\dsh-ac-tools
New-Item -ItemType Junction -Path node_modules\@local\dsh-ac-compaction -Target <本仓库路径>\dsh-ac-compaction
```

**2. 登记 bundle** —— profile 的 `package.json`：

```jsonc
{
  "dependencies": {
    "@local/dsh-ac-tools": "link:<本仓库路径>/dsh-ac-tools",
    "@local/dsh-ac-compaction": "link:<本仓库路径>/dsh-ac-compaction"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...现有 bundle 保持原样...
        "@local/dsh-ac-tools",
        "@local/dsh-ac-compaction"
      ]
    }
  }
}
```

重启 DSH 生效。之后可以在 **设置 → 插件** 里单独开关这三个功能行：

```
include:dsh-ac-tools
include:dsh-ac-compaction-system
include:dsh-ac-compaction-nudge
```

引擎层是 `include:compaction-basic` 这一行的 override，同样在插件列表里可见。

## 三个部件各自在干什么

### 1. 目录即工具（`dsh-ac-tools`）

```js
// 任何目录下的 any-tool.mjs
export default {
  name: 'now',
  description: '返回当前时间。',
  inputSchema: { type: 'object', properties: {} },
  async execute() { return new Date().toISOString() },
}
```

- 工具代码**永远不进 harness 主进程**：扫描和调用都走子进程
- 名字强制加前缀（默认 `ac_`），撞名拒绝而不是静默覆盖
- 超时杀进程、输出中段截断、目录变更热重载
- 相对路径按包目录解析，克隆下来即可跑；绝对路径原样使用

### 2. 总结升格 system（`dsh-ac-compaction-system`）

DSH 压缩后总结是一条 user 消息，模型容易把它当"用户塞的表"而从头重做。
本层在每次 `agent/created` 时给该 agent 注册一个 `systemPrompt.section`，
组装时从 session log 现查最新总结，附「这是你已完成的工作，接着做」的框架。

不存状态、不改引擎、纯叠加——失效时自动退回 DSH 原生行为。

### 3. 指令增强引擎（`dsh-ac-compaction/engine`）

`BasicCompactionEngine` 子类，只改总结指令：最初目标逐字保留、明确丢弃清单、
总结必须比被替换内容更小、强化旧 checkpoint 继承。调用信封与用量统计保持一致。

### 4. 空谈追问（`dsh-ac-compaction-nudge`）

模型连续不带工具调用的步数达到阈值时，在**下一次请求**里追加一条一次性提醒
（`agent/pre-step` 替换 messages，不写入会话历史）。到 `maxNudges` 后彻底安静，
任何一次工具调用都会重置计数。

## 设计约束

- 每个包都能单独停用，回滚就是关掉那一行
- 不注册 compaction 组件以外的循环、不改其他插件配置
- 不读取、不写入任何用户凭据；配置里不含本机路径与账号信息

## 许可

个人项目，代码可自由参考、复制与修改；不提供任何担保，也不承诺与未来 DSH 版本兼容。
