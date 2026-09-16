# MiniMax Code 移植插件真实验收（2026-09-17）

插件：`~/.minimax/plugins/llm-verifier/`（源码 `minimax-code-plugin/`，MCP stdio + Skill，零依赖）。
注册：`~/.minimax/mcp/mcp.json` + `~/.minimax/mcp.json`（**必须 configured:true**）。

## 真实 e2e（mcode 0.4.7 引擎，MiniMax-M3 候选代理）

| 步骤 | 结果 |
|---|---|
| verified_best_of(candidateCount=2, 并发2) | review_pending：2 个真实 M3 候选代理在隔离 worktree 各自修复并通过 npm test 3/0 |
| 父代理评审 | 读 report.md + 两份 patch：均只改 src/slugify.js、纪律相同；candidate-1 用 Unicode \p{P} 更完备 → 选它 |
| select_verified_candidate(candidate-1) | winner_selected（审计留痕 reason） |
| apply_verified_winner | applied，appliedFiles=[src/slugify.js]，origin `node --test` = **3 pass / 0 fail** |
| rollback_verified_winner | 基线还原（真实反向补丁） |
| apply（rolled_back 状态重落） | applied，3/0（DSH parity） |
| 守卫 | 重复 rollback 拒绝 ✓；已 applied 后 select 拒绝 ✓（mock e2e） |

## 验证矩阵
- MCP 协议冒烟：initialize / tools/list(6) / 配置读写 / 非法配置拒绝
- 确定性 mock e2e：全状态机 + 守卫（tests/mock-mcode.mjs 驱动）
- 工具可见性：mcode exec 会话真实调用 verifier_get_config（"configured:true" 是加载门槛）
- 真实 e2e：本文件

产物：minimax-report-final.md、candidate-*.patch、minimax-run-review-pending.json
