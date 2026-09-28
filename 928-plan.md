# 928-plan · 全面复盘结论与修复执行计划

- 生成：2026-09-28（928.md 四工位复盘同日晚间，第二波）；**执行回写：同日深夜（批次 0+2 施工完毕后）**
- 基线：`main` = `16893af`（HEAD，docs 提交），工作区 clean，`fork/main` 同步，`origin/main` ahead 44
- 前序文档：`922.md`（交接）→ `924.md`（16+ 波修复台账，428KB）→ `928.md`（四工位审查，25KB）→ **本文档（修复派单计划）**
- 本轮方法：2 个子代理中 1 个成功执行（七端安装面审计，带回 10+ 条增量发现）；另 3 路原计划评审（引擎代码 / DSH 插件 / 测试语义）因宿主并发上限只允许单子代理，**改由主会话亲验关键点替代**（928 四 P0 逐条 grep 验证、lib/构建时间线、e2e 测试清单抽查）——引擎与 DSH 源码的深度评审不重复做，因为 924（A1-A19/B1-B19）+ 928（四工位）已覆盖，本轮只做增量。

---

## 执行回写（2026-09-28 深夜）

**施工方式**：P2/P3 子代理三次死于宿主验证码超时（Captcha verification timed out）后，P2 起全部由主会话亲自施工（每步机械验收留证）；**独立审查改走 `opencode run` headless 通道成功执行**（P7，审查员结论"主体逻辑正确、测试覆盖到位、与派单 1:1 对齐，可以提交"），施工/审查分离的纪律未破。

### 批次 0 + 批次 2 执行结果

| F 项 | 状态 | 验收证据 |
|---|---|---|
| F1 OpenCode 旧引擎同步 | ✅ | 四副本哈希一致（施工时 `c08350db`，P5 后再同步至 `71d64d1b2ff1`）；stdio 握手 6 工具；`opencode mcp list` ✓ connected |
| F2 sync TARGETS 扩容 | ✅ | OpenCode 引擎+SKILL 入 TARGETS；normHash null 语义；五宿主 enabled/configured 断言；三变异（字节漂移/enabled 翻转/目标删除）全红、还原复绿；**P7 追加修复**：TOML 段内 `#` 注释行不再被当真值（变异验收红/绿） |
| F3 Codex enabled=true | ✅ | config.toml:638 行级替换，全文件唯一差异；被 F2 断言看住 |
| F4 ZCode enabled 键 | ✅ | JSON 回读确认；被 F2 断言看住 |
| F5 final-gate 超时预算 | ✅ | stage 默认 20 分钟 + TS/e2e 30 分钟覆盖 + e2e `--test-timeout=600000`；反事实实验：挂死形状 3 秒内返回且判红 |
| F6 E6 refused 断言 | ✅ | 变异实验：删引擎 assertRunId 后 E6 红（并复现穿越证据 `%TEMP%\evil\manifest.json`），原版绿 |
| F7 锁 release 所有权校验 | ✅ | `src/core.ts` release 读回记录 pid+hostname 匹配才删（撕裂/外来不删）；自欺注释重写；rollback 破坏性第一刀前 `assertStillHoldingLock`；`tests/lock.test.ts` 3/3；rollback 套件 35/35（**其中一条既有测试的收尾原本断言的正是 P0-1 的洞**——依赖旧 release 删外来锁，已改为走合法 stale 接管路径）；typecheck 干净；**P7 追加修复**：hostname 统一为模块级快照 `PROCESS_HOSTNAME`（防进程中途改名误判） |
| F8 bridge-guard SystemExit | ✅ | 三格实验：旧版 `-O` 下静默假绿复现 → 新版判 `BRIDGE GUARD FAIL` 非零 → 好实现仍绿 |
| F9 gitignore 纳管回执 | ✅ | 30 份日志 3412 行入版本控制（staged） |
| F10 清理 | ✅ | 安装位 `.claude-plugin/` 已删；顶层 tgz 已不存在；**`{}` 垃圾文件删后复发**（23:05 又生，生成源未定位——见下轮清单） |
| F11 922.md 横幅 | ✅ | 头部加"状态已被 924/928/928-plan 覆盖"横幅 |
| F12 HOSTS 修正 | ✅ | mcp-config 改盯 MiniMax plugin 路径 + Qoder CN 工作区 `.mcp.json` + 两版审批列表；矛盾注释删除；遗留根 mcp.json 条目清除（带备份）+ legacy 清扫检查；`MCP CONFIG OK` 七视角全解析同版引擎 |
| F15 引擎审批门 | ✅ | `apply_verified_winner` 两段式：无 `confirm` 跑完全部只读预检后返回 `approval_required` 预览（不动树、不落 apply-state）；SKILL.md 契约同步（P7 追加：明确 confirm 必须是布尔 true）；e2e 新测试"预览不动树"绿；**accept-deployed 夹具连带升级**（契约变更必须同步验收夹具——第一轮门禁就红在这里，已修并把审批门纳入部署验收断言） |
| F16 词表扩枚举 | ✅ | contracts.ts + index.ts 宿主 schema 双侧扩（run 级 timeout/cancelled、apply 级 applied_validation_cancelled、validationStatus cancelled、selectionMethod 并集）；typecheck 揪出宿主 schema 两处死分支并同步修 |
| F17 git timeout env | ✅ | TS 侧实现 `LLM_VERIFIER_GIT_TIMEOUT_MS`（默认 10 分钟、上限 1 小时、非法值回退）；git 套件 9/9 |
| F18 rollback 清 index | ✅ | 反向 apply 后对 touched 路径 `git reset --quiet --`（`:(top,literal)` pathspec，分批 100），失败披露；e2e 新测试"staged 残留不卡死下一次 apply + 同 repo 再落地"绿 |

### 施工中额外发现并处置

1. **dsh 环境断裂（与代码无关）**：`verifier-e2e` profile 依赖的 `dsh-e2e-auto-approve` 插件包在 dsh 升级后解析不到（候选 131ms 全灭 no_winner）——`dsh plugin --profile verifier-e2e install` 重装后恢复，accept-ts 复绿（review_pending→selected 驱动成功）。
2. **夹具滞后契约**：accept-deployed 直调 apply 不带 confirm 被新审批门拦下——修复并把"无 confirm 只给预览不动树"变成部署副本验收断言（两副本 PASS）。
3. **变异实验自身打偏两次**（TOML `replace(...,1)` 命中别段、正则被 args 数组 `[` 截断）——都以"结果与预期不符即停、重构造实验"处置，教训与 F3 同源：**对 TOML/分段文件的断言必须行级、段级精确**。

### P7 独立审查遗留（下轮清单）

- **`{}` 垃圾文件生成源**：删后复发（0 字节、mtime 与门禁/验收运行时段重合），工具目录 grep 未定位——下轮专项。
- sync-deployed 的 minimax 项（`~/.minimax/mcp/mcp.json`）与 mcp-config 的 plugin 路径指向不同注册面，补注释说明两条文件的关系。
- reset pathspec 对 `:` 开头路径的纵深断言（当前不可触发）。
- final-gate 快速 stage 显式缩短预算；APPROVALS label 一致性断言。
- 928.md §十 第二/三批中未列入本批的项（F13/F14 依赖主上操作，维持原状）。

### 最终验收

e2e 59/59、lock 3/3、rollback 35/35、git 9/9、typecheck OK、accept-ts（真实模型）PASS、accept-deployed（双副本 stub）PASS、mcp-config OK、sync-deployed IN SYNC（15/15）。全量门禁 21 阶段最终轮见 `gate-full-928.log`（GATE_EXIT 判定以该日志末行为准）。

---

## 0. 一句话总览

**代码侧的洞 928.md 已经找齐了（4 P0 全部经本轮快验确认仍未修）；本轮的净增量在"盘上真实状态"——OpenCode 宿主正在跑一份缺 19 项安全修复的旧引擎、Codex 注册被静默禁用、ZCode 开关键丢失，以及 f5111a0 之后门禁一次都没跑过。** 修复计划分三批：第一批 11 条零契约负担可直接开工，第二批 3 条需主上操作/裁定，第三批 4 条契约变更需主上裁定。

---

## 一、本轮新发现（928 四工位未覆盖的增量）

### 安装面（审计子代理实测，2026-09-28）

| # | 级别 | 发现 | 证据 |
|---|---|---|---|
| N1 | **P0** | **OpenCode 宿主在跑旧引擎**：`~/.config/opencode/skills/llm-verifier/mcp-server.mjs` = 25,918 B（922 时代版本），其余三副本 = 107,699 B（`cbb1f5f0`，含 924 全部 19 项安全修复 A1-A19 + 平台分支）。OpenCode 副本不在 924 `--sync` 的 TARGETS 里，从未同步 | sha256 实测：OpenCode 副本 `a7de71c2…`（= 922.md 时代哈希）vs 其余三份 `cbb1f5f0…`（CRLF 归一 `c08350db…`）。这正是 928 P1-2（sync TARGETS 覆盖不全）的真实受害者 |
| N2 | P1 | **Codex 注册被静默禁用**：`~/.codex/config.toml:638` `enabled = false`。引入窗口 9/25–9/28（`bak-20260925-mcp` 时无此键，`bak-before-ocx-sync-20260928` 时已是 false），722 行文档零记载 | config.toml 实读 + 两份备份对照 |
| N3 | P1 | **ZCode 条目丢失 `enabled` 键**：`~/.zcode/cli/config.json` 的 `mcp.servers.llm-verifier` 条目在，但 9/28 的批量改写把 922 §9 声称的 `enabled:true` 丢了（键不存在） | config.json 实读；备份 `bak-enable-llmverifier`(9/21) 在 |
| N4 | P1 | **f5111a0 之后门禁从未跑过**：`lib/*.js` mtime 全部停在 09-26 12:23（= 波次 28 最后一跑），而 `f5111a0`（09-28 05:13 改 `src/git.ts`）之后只有 docs 提交。928 四工位全是静态审查。924 波次 16 的教训"每波之后跑全量"被违反 | lib/ ls -lt vs git log 时间戳；门禁第 104 阶段会自建 lib，所以这不是"测旧代码"，是"修复未经门禁验证" |
| N5 | P2 | MiniMax 双注册文件状态相反：`~/.minimax/mcp/mcp.json` `enabled:true` vs 根 `~/.minimax/mcp.json` `enabled:false`。928 §八已查明真实加载走 plugin 路径（两文件都是遗留），但根文件的 false 正是 P0-4 假红的原料 | 双文件实读 |
| N6 | P2 | 国际版 Qoder 工作区 `.qoder/settings.json` 不存在（922 §3.6 声称写入并回读过）；`~/.qoder/settings.json` 审批列表 9 项无 `llm-verifier`（928 事实校准 2 已确认 CN 侧 13 项含） | 盘上实测 |
| N7 | P2 | 安装位残留断链清单：`~/.minimax/plugins/llm-verifier/.claude-plugin/plugin.json` 仍在（`${PLUGIN_ROOT}` 引用，922 §7 判死的那份只从仓库删了，安装位没删） | 实读 |
| N8 | P2 | **发布链依赖本地构建纪律**：`lib/` 被 `.gitignore` 忽略（从未进版本控制）但 `package.json.files` 含 `lib` —— tgz 打包打的是本地构建产物；工作区根还躺着 `dsh-llm-verifier-0.2.0.tgz`(143.8K, 922 时代)，其内 lib 必然过期 | git check-ignore 实证 + files 字段 |
| N9 | P2 | 三端数据目录（`~/.zcode/`、`~/.codex/`、`~/.config/opencode/` 下 llm-verifier-data）不存在 = 这三端零活体调用（目录由引擎首调时自建，功能无害，但印证 928 交叉 3：宿主侧从未真正用过） | find 实测 |
| N10 | P3 | 922.md 五处声明已过期（四处哈希被 924 波推翻未回填、m3-self-ask 漂移描述不准、.claude-plugin"已删"只对仓库成立、Codex enabled 未记载、.qoder/settings.json 已消失） | 审计逐条对照 |
| N11 | P3 | 工作区根 0 字节 `{}` 垃圾文件（9/28 产生，疑似命令重定向事故）；顶层 922.md 已被移入 dsh-llm-verifier/（顶层不再有） | ls 实测 |

### 测试面（主会话抽查，替代未能派出的评审员）

- `e2e.test.mjs` 实测 57 条 test（2090 行），与 928 记载一致。抽读测试名清单：924 波次的修复**大多带了牙齿测试**——超时死线（:596）、stdin 断开进程树回收（:625）、补丁抓取期间 ping 可应答+取消掐断 git diff（:655）、S21/S22 死线幸存者判决（:723/:775）、apply 可取消（:814）、非 UTF-8 字节级补丁（:913）、撕裂 config 故障关闭（:426）、runId 穿越/坏帧/模型名注入（:383）、评审解析失败不得伪造 winner（:359，即 A7 的反向测试——924 标记的"契约冲突"已在后续波次改掉）。
- **残余盲区**（测试名层面未见）：并发两 run 同 repo（引擎侧进程内 Promise 链 :517-523 是否真的串行了跨请求并发，928 交叉 1 指出 B 侧无锁）、跨进程双宿主同 repo（.mjs 无仓库锁的根本问题，测试无法覆盖单进程内模拟）。这两条并入第三批契约项 12。

---

## 二、928 四 P0 现状快验（本轮逐条确认，全部仍未修）

| # | 内容 | 快验证据（HEAD = 16893af） |
|---|---|---|
| P0-1 | 仓库锁 release 无条件删锁文件 | `src/core.ts:429-437` 原样：`await rm(lockPath, { force: true }).catch(() => {})`，且自欺注释（"reclaimed by the heartbeat check"——该机制不存在）还在 |
| P0-2 | 真实宿主侧（.mjs）apply 无审批门 | 引擎全文 grep `approval\|confirm\|approve` 唯一命中 :1567 的无关 message 文本；`applyVerifiedWinner` 守卫链全是机械检查 |
| P0-3 | 门禁 e2e 阶段无超时预算（挂死而非判红） | `final-gate-924.mjs:72` spawnSync 选项无 `timeout`；`:140` e2e stage 无 `--test-timeout`（TS 侧 :120 有） |
| P0-4 | 门禁盯已退出的加载路径，真跑的 plugin 路径无人看守 | `mcp-config-924.mjs` HOSTS 仍 5 项全在 `C:/Users/datoo/`，minimax 项仍指根 `mcp.json`（enabled:false 假红源）；注释仍称 "Qoder CN and Qoder carry only SKILL.md: no MCP registration exists"——与 928 事实校准 2（workspace `.mcp.json` + CN 审批列表 13 项）直接矛盾 |

---

## 三、修复执行计划（派单）

### 批次 0 · 零契约负担，可直接开工（预期全绿后跑一次全量门禁）

| # | 动作 | 位置/方式 | 验收 |
|---|---|---|---|
| F1 | **同步 OpenCode 旧引擎**（N1，本轮最高优先） | 以仓库 `.minimax-plugin/mcp-server.mjs` 为源覆盖 `~/.config/opencode/skills/llm-verifier/mcp-server.mjs`；同时更新该处 SKILL.md（旧版缺 reviewTimeoutMin 说明） | 四副本归一哈希一致；`opencode mcp list` 仍 ✓ connected；stdio 握手 6 工具 |
| F2 | **sync-deployed TARGETS 扩容**：把 OpenCode 路径 + 各端 enabled/configured 断言写进同步脚本，防止 N1/N2/N3 复发 | `docs/proof/tools/sync-deployed-924.mjs`（配合 928 P1-2 的 `MISSING` 守卫一起修） | 拔掉任一副本/翻转 enabled → 脚本非零退出（变异验证） |
| F3 | 恢复 Codex `enabled = true`（或主上明示弃用 Codex 端则删除条目） | `~/.codex/config.toml:638` | 回读 + F2 断言 |
| F4 | 补回 ZCode `enabled: true` 键 | `~/.zcode/cli/config.json → mcp.servers.llm-verifier` | 回读 + F2 断言 |
| F5 | 门禁超时预算（928 P0-3） | `final-gate-924.mjs:72` spawnSync 加 `timeout` + `r.signal !== null` 判 FAIL；`:140` 补 `--test-timeout=600000` | 反事实：人为挂起的 stage 必须在预算内判红 |
| F6 | 探针 E6 改用 `refused()`（928 P1-1） | `probe-any-924.mjs:110` | 变异：删引擎 `assertRunId` 后 E6 必须红 |
| F7 | 锁 release 前校验所有权（928 P0-1） | `src/core.ts:429-437`：release 读回锁记录，`pid+hostname` 匹配才 `rm`；`rollbackVerifiedWinner` 破坏性步骤前补 `assertStillHoldingLock`（全仓唯一调用点现在只有 :2448） | 新单测：模拟陈旧锁被接管后 release 不得删新持有者的锁 |
| F8 | bridge-guard `assert` → `raise SystemExit`（928 第一批 7） | `bridge-guard924.py` 三处 | `python -O` 下仍能判红 |
| F9 | `.gitignore` 纳管门禁回执（928 §7.1 矛盾） | 为 `docs/proof/logs/**` 加 `!` 例外，补 `git add` 那 30 份 | `git ls-files docs/proof/logs` 非零 |
| F10 | 清理：安装位 `.claude-plugin/`（N7）、工作区根 `{}` 垃圾文件（N11）、过期 tgz 移档或重建（N8） | 直接删/移 | 盘上复查 |
| F11 | 922.md 勘误五处（N10）或在其头部加"状态已被 924/928 覆盖"横幅 | 文档 | 逐条对照 |

**批次 0 完成后的硬要求**（924 波次 16 教训）：跑一次全量门禁（`node docs/proof/tools/final-gate-924.mjs`，不带 --fast），21 阶段全 PASS 才算批次关闭——这同时关闭 N4（f5111a0 后零门禁）。

### 批次 1 · 需要主上操作或真机探针

| # | 动作 | 依赖 |
|---|---|---|
| F12 | 门禁 HOSTS 修正（928 P0-4）：minimax 项改盯 plugin 路径 `~/.minimax/plugins/llm-verifier/.minimax-plugin/mcp.json`，根 `mcp.json` 降级为遗留告警；补 Qoder 审批列表检查；删除与事实矛盾的注释 | 纯代码，但**判"哪条是真实加载路径"需以宿主重启实测为准**（F13） |
| F13 | Qoder CN 在本工作区开一次新会话验证加载（928 事实校准 2：授权后从未开过）；MiniMax/Codex/ZCode/OpenCode 各做一次 `verifier_get_config` 活体调用（关 N9 零活体） | **主上操作**（或授权代理驱动桌面） |
| F14 | `mcp.json` 绝对/相对路径与 `${PLUGIN_ROOT}` 展开行为：以宿主实测裁定（924 O 系遗留） | F13 同批 |

### 批次 2 · 契约变更，必须主上裁定后动工（928 第三批原样保留）

| # | 议题 | 裁定点 |
|---|---|---|
| F15 | `.mjs` 加审批门（`confirm` 入参）+ 单合格候选是否自动选中 + `reason` 必填 | 928 建议以 TS 侧为准补齐；**默认方案：补齐**（真实宿主侧裸奔是 4 P0 里最重的一条） |
| F16 | 状态词表统一：扩 TS 枚举（run 级 `timeout/cancelled`、apply 级 `applied_validation_cancelled`）而非削 .mjs 语义 | 方向已定（扩不削），主上点头即可 |
| F17 | `LLM_VERIFIER_GIT_TIMEOUT_MS` 可调性 + O2 语义（单 git 步骤能否超过被配小的 totalTimeoutMin） | 需裁定 |
| F18 | rollback 兜底五段式移植到 `.mjs`（patchReversesCleanly + HEAD 比对 + unstage）——否则 rollback 后 dirty 树卡死下一次 apply | 方向已定，主上点头 |

### 遗留引用（不在本文档复制，按原文执行）

- 924.md 残余清单：**25 条 OPEN 原样成立**（928 D 工位逐条复核），owner 分布 我 7 / 主上 7 / 上游 1 + 2 条另标待裁定；其中 5 处台账文字必须废弃重写（928 §7.4/§十 末段）。
- 928.md P2 清单（A/B/C 三工位 ~20 条）：A 侧 8 条（core.ts 状态矛盾、原子写、锁泄漏、taskkill 无超时、settings NaN 等）、B 侧门禁 6 条、C 侧契约 5 条，**优先级全部低于上表 F1-F18**，排入批次 2 之后的常规迭代。
- 上游 PR：#5 已被 #6 取代（`6b552e1`/`dbe6dd5` 记录了 retarget 与 peer 同步 772d3aa），合并仍是**主上/GitHub 侧唯一动作**。

---

## 四、验收与防复发

1. **每批之后跑全量门禁**（不是仪式——924 波次 16 的回归 N21 与夹具缺口只有这个机制抓到过）。
2. **同步脚本成为唯一部署通道**：任何引擎改动后 `sync-deployed` 必须覆盖全部四副本 + 各端 enabled/configured 断言（F2），杜绝"改了仓库忘了安装位"——本轮 N1 就是这个缺口 incubate 出来的真实事故。
3. **台账纪律**：每个 F 项关闭时在对应文档（924 残余清单/928 P0 表）回写状态，禁止只改代码不改台账（928 §八事实校准 3 的教训反用）。
4. **文档水位行**：922/924/928 各加一行"引擎归一哈希 = `<当前>`"，下一轮审计先对水位再逐盘扫。

---

## 五、本轮诚实边界

- 引擎/TS 源码没有做新一轮逐行盲审（924+928 已两轮覆盖，本轮只做增量快验）；若主上要求第三轮独立盲审，需在子代理名额释放后单独派。
- e2e 57 条中只抽读了测试名与 15 条关键断言（rtk 截断了后 42 条名单），"断言了错误行为当契约"类问题可能仍有漏网；批次 0 完成后建议补一次全量逐条语义评审。
- POSIX 分支、`@deepseek-ai/dsh-settings` 宿主实现：928 已声明未覆盖，本轮同样未覆盖（本机 Windows 无 POSIX 活体条件）。
