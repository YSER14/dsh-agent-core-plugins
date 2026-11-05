# @local/dsh-ac-tools

agent-core 式的「目录即工具」插件，为 DeepSeek Harness 服务。

往配置的目录里扔一个 `.mjs` 文件，模型就多一个工具：

```js
// my-tools/now.mjs
export default {
  name: 'now',
  description: '返回当前时间（ISO 8601 格式）。',
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return new Date().toISOString()
  },
}
```

工具名自动加前缀（默认 `ac_`，避免与 DSH 内置工具撞名），执行在独立子进程里，
超时会杀进程，输出过长会在中段截断。工具代码永远不进 harness 主进程。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `dirs` | `[]` | 工具目录列表。相对路径按**本包目录**解析（`./demo-tools` 开箱可用），绝对路径原样使用；后面的目录覆盖前面的同名工具 |
| `namespace` | `ac` | 工具名前缀，注册前会查重，撞名就拒绝 |
| `timeoutMs` | `60000` | 单次调用超时（毫秒），到点杀子进程 |
| `maxOutputChars` | `20000` | 输出上限，超长中段截断（保留头 70% / 尾 30%） |
| `maxLogChars` | `8000` | 子进程日志保留上限（错误报告用） |
| `watch` | `true` | 目录变化后自动重新注册 |

## 演示工具（`demo-tools/`）

| 工具 | 用途 |
|---|---|
| `ac_now` | 返回当前时间，最小可用样例 |
| `ac_count_files` | 递归统计某目录下指定扩展名的文件数，演示入参 |
| `ac_spin_forever` | 死循环，用来验证超时能真的杀掉子进程 |
| `ac_always_fails` | 抛错，用来验证异常会变成一条正常工具结果 |

## 与 DSH 的边界

本插件只调用 `ctx.fs` / `ctx.subprocess` / `ctx.tools.register`，
不注册任何 compaction 或循环组件，不改其他插件的任何配置；
停用插件时，注册的全部工具随 `ctx.effect` 一并注销。
