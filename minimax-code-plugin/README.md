# llm-verifier for MiniMax Code

dsh-llm-verifier 的 MiniMax Code 移植版：best-of-N 多候选生成 → 隔离验证 → 评审路由 → 择优落地。

## 形态

MiniMax Code 插件体系无原生工具注册/设置卡片，本插件采用 **MCP stdio 服务器 + Skill** 形态（与官方 csb-bridge 同构）：

```
.minimax-plugin/
├── plugin.json            # agent-plugins.org 1.0.0 schema
├── mcp.json               # stdio 入口（node mcp-server.mjs，零依赖）
├── mcp-server.mjs         # MCP 协议 + 引擎（worktree 隔离/验证/评审/补丁状态机）
└── skills/llm-verifier/SKILL.md
```

## 工具

| 工具 | 作用 |
|---|---|
| verified_best_of | N 个候选在独立 git worktree 内由 `mcode exec --permission off` 独立求解，各自跑验证命令；全部通过且>1 时返回 review_pending |
| select_verified_candidate | 人工/父代理评审后择优（审计留痕） |
| apply_verified_winner | 优胜补丁落到原仓库（git apply --check 前置） |
| rollback_verified_winner | 反向补丁回滚（落盘后文件被改动则拒绝） |
| verifier_configure / verifier_get_config | 设置（候选数/并发/验证命令/评审模式/模型/超时），持久化 JSON |

评审路由：`parent_agent`（父代理读 report+patches 评审，默认）| `mcode_model`（再起一个 mcode exec 用 --output-schema 产出评分回执，严格 selected=最高分）。

## 安装（本机已完成）

1. 拷贝 `.minimax-plugin/` 到 `~/.minimax/plugins/llm-verifier/`
2. 在 `~/.minimax/mcp/mcp.json` 与 `~/.minimax/mcp.json` 注册（**必须 `"configured": true`，否则加载器忽略**）：
```json
"llm-verifier": { "type": "stdio", "command": "node",
  "args": ["C:/Users/datoo/.minimax/plugins/llm-verifier/.minimax-plugin/mcp-server.mjs"],
  "enabled": true, "configured": true, "timeout": 3600000 }
```
3. 新开的 mcode exec / 桌面会话即可用（`mcode plugin list` 只列 marketplace 插件，本地插件不显示属正常）

## 关键实现注意（踩坑实录）

- mcode exec 的 prompt 必须走 `--input -`（stdin）——多行 prompt 经 shell:true 的 argv 会被换行截断
- git worktree add 参数顺序：`worktree add -b <branch> <path> <base>`
- 候选 prompt 内置 ISOLATION CONTRACT（DSH 时代同款教训：没有它候选会跑到原仓库改文件）
- apply 用 worktree `git add -A + diff --cached --binary` 生成补丁（覆盖未跟踪新文件），rollback 前置 `apply -R --check` 做脏检测
- `mcode plugin list` 只显示 marketplace 插件；本地目录插件不被列出但仍加载

## 验证

- 确定性 e2e（mock mcode）：协议冒烟 + 全状态机（review_pending→select→apply→rollback→re-apply、非法操作拒绝）
- 真实 e2e：`G:\zcode-project\llm-verify\mcode-e2e\slug-repo`，3 个失败测试 → verified_best_of(2) → 真实候选代理 → review/apply → npm test 3 pass / 0 fail
