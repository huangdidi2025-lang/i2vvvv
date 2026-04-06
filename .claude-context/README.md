# .claude-context — 历史开发上下文

本目录保存 I2V 项目的历史对话决策、技术选型、踩坑经验，供新会话中的 Claude 快速获取上下文。

## 文件说明

- `session_2026-04-06.md` — 2026-04-06 会话记录：尝试重构 + 测试 + 回滚到 v1.0.3
- `known_issues.md` — 已知问题清单与待办
- `design_decisions.md` — 关键技术决策与原因
- `test_strategy.md` — 测试方法与自动化测试脚本参考

## 新会话使用方式

在新会话开始时，Claude 会自动读取 `../CLAUDE.md`。如需深入历史决策，可主动阅读本目录下的文件。
