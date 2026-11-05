# @local/dsh-ac-compaction

agent-core 式压缩增强，三层独立开关。

## 第 1 层：总结升格 system（`dsh-ac-compaction-system`，默认启用）

DSH 压缩后，总结以一条 user 消息落在会话里；模型可能把它当「用户塞的表」而从头重做
（agent-core 在真实端点上的实测是 1/6 正确续跑）。本层把**最新一条总结**升格进
system 提示词，并附「这是你已完成的工作，直接接着做」的框架（同一实测下 6/6）。

- 组装时从 session log 现查，不存状态：多会话天然隔离、重放确定、卸载即消失
- 纯叠加：DSH 的 checkpoint user 消息照常写入；本层失效时压缩自动退回原行为

## 第 2 层：指令增强引擎（`dsh-ac-compaction/engine`）

`BasicCompactionEngine` 的子类，唯一改动是总结指令：

- 「用户最初目标」逐字保留，且要求任何情况下都不许留空
- 明确丢弃清单：寒暄、重复工具转录、已被推翻的中间输出
- 强调总结必须**小于**被替换内容（防止总结越压越胖）
- 保留并强化旧 checkpoint 继承规则

压力阈值、保留策略、事务、配对、溢出恢复全部继承原引擎；调用信封保持一致
（`purpose: 'compaction'`），暖前缀缓存与用量统计不受影响。

启用方式是在部署层把 `@deepseek-ai/dsh-compaction-basic` 那一行换成
`@local/dsh-ac-compaction/engine`（即本包 `cordis.patch.yml` 里的 override，一行、可逆）。

## 第 3 层：空谈追问（`dsh-ac-compaction/nudge`，默认启用）

模型出现「只说话不调工具」的连续步数时，在**下一次**请求里追加一条一次性提醒
（不进会话历史）。到达 `maxNudges` 后彻底安静，任何一次工具调用都会重置计数。

| 字段 | 默认 | 说明 |
|---|---|---|
| `afterSteps` | `1` | 连续多少步不带工具调用后开始提醒 |
| `maxNudges` | `2` | 连续提醒上限，防止无限催促与花费失控 |

## 回滚

停用 bundle 即回到 DSH 原生压缩行为；引擎层单独回滚不影响 system 层与追问层。
