// Generate the WAVE-numbered gate section AND rewrite the 交付状态 headline from the same
// parse of the gate log, so the two cannot disagree with each other or with the run.
// Every value is parsed; anything that cannot be found aborts before a byte is written.
import fs from "node:fs";
import crypto from "node:crypto";

const LOG = process.env.LOG;
const DOC = process.env.DOC;
const ANCHOR = process.env.ANCHOR;
const fail = (why) => {
  console.log(`ABORT (nothing written): ${why}`);
  process.exit(1);
};
if (!LOG || !DOC || !ANCHOR) fail("LOG/DOC/ANCHOR env vars are required");
// The published heading, the 交付状态 headline and the duplicate-section guard are all keyed on the wave
// number, so it has to be an input. It used to be a literal baked into the generator: the next wave's run
// would have published a section labelled 波次 25, and the "already in the ledger" guard would then have
// refused every later run with a message naming a third wave number.
const WAVE = Number(process.env.WAVE);
if (!Number.isInteger(WAVE) || WAVE < 1) fail(`WAVE must be a positive integer, got ${JSON.stringify(process.env.WAVE)}`);

const log = fs.readFileSync(LOG, "utf8");
const cut = log.lastIndexOf("================ FINAL GATE");
if (cut < 0) fail("no FINAL GATE table in the log — the run never reached its summary");
const table = log.slice(cut);
const rows = table.split(/\r?\n/).filter((l) => /^(PASS|FAIL)\s/.test(l));
if (rows.length === 0) fail("FINAL GATE table has no stage rows");
const declared = /stages run: (\d+)/.exec(table);
if (!declared) fail("`stages run:` missing, so the row count cannot be cross-checked");
if (Number(declared[1]) !== rows.length) fail(`stages run=${declared[1]} but ${rows.length} rows parsed`);
// Every stamp has to come from the SAME block the rows came from. `exec(log)` takes the FIRST match in the
// whole file, so on a two-run log (the `GATEC_RC` fallback below exists precisely because such logs happen)
// the table would be run 2's while `GATE_EXIT`, the window and therefore both mtime guards were run 1's —
// a green published over an engine edit that happened in between. The gate prints GATE_START/GATE_END/
// GATE_EXIT after the banner, so they are inside `table`; if a block lacks them, say so instead of
// quietly reaching back into an earlier run.
const gateExit = /GATE_EXIT=(-?\d+)/.exec(table) ?? /GATEC_RC=(-?\d+)/.exec(table);
if (!gateExit) fail("the LAST FINAL GATE block carries no GATE_EXIT/GATEC_RC — refusing to borrow an earlier run's verdict (read the log, not the notification)");
const bad = rows.filter((l) => l.startsWith("FAIL"));
if (bad.length) fail(`${bad.length} stage(s) red — fix or explain, then re-run:\n${bad.map((l) => `  ${l}`).join("\n")}`);
// The window comes from the log file's own birth/last-write times when the gate did not print
// explicit stamps — those are filesystem facts, not numbers I remember. `--test-*` durations in the
// rows are the cross-check: sum(stage) must land inside the window.
const window = /^GATE_START=(.+)$/m.exec(table)?.[1] ?? fs.statSync(LOG).birthtime.toISOString();
const end = /^GATE_END=(.+)$/m.exec(table)?.[1] ?? fs.statSync(LOG).mtime.toISOString();
if (!window || !end) fail("the log has no start/end stamps and its file times are unavailable");
// The window's load is a measurement the gate now takes at both ends. If it is missing, this run predates
// the meter (or the meter broke) — say so rather than writing "quiet machine" from memory.
const loadA = /LOAD_START=(\{.*?\})/.exec(table);
const loadB = /LOAD_END=(\{.*?\})/.exec(table);
if (!loadA || !loadB) fail("no LOAD_START/LOAD_END in the gate log: the run did not sample machine load, so this section must not claim anything about the window being quiet");
const la = JSON.parse(loadA[1]);
const lb = JSON.parse(loadB[1]);
if (la.nodes < 0 || lb.nodes < 0) fail(`the load sampler itself failed (${loadA[1]} / ${loadB[1]})`);
// A foreign population with a summed CPU of exactly 0 means the meter is broken, not that the box was idle
// — that is precisely what the first version of this sampler printed for 50 live processes. And classifying
// NONE of 70 processes as foreign is the second version of the same bug (a field-index mistake), which is
// why both shapes are refused here rather than trusted.
if ((la.foreign > 0 && la.foreignMs === 0) || (lb.foreign > 0 && lb.foreignMs === 0)) {
  fail(`the load meter reports 0 ms across ${la.foreign}/${lb.foreign} foreign processes — broken sampler, not an idle box`);
}
if ((la.nodes > 5 && la.foreign === 0) || (lb.nodes > 5 && lb.foreign === 0)) {
  fail(`the load meter saw ${la.nodes}/${lb.nodes} node processes and called none of them foreign — parse bug, refuse to publish "quiet machine"`);
}
const foreignCpu = lb.foreignMs - la.foreignMs;
const loadNote = `窗口首尾 node 进程 ${la.nodes} → ${lb.nodes} 个（其中命令行不属于本项目的 ${la.foreign} → ${lb.foreign} 个），外来进程累计 CPU ${la.foreignMs} → ${lb.foreignMs} ms，**差值 ${foreignCpu} ms ≈ ${Math.round(foreignCpu / 1000)} 个 CPU-秒，才是"这一跑期间别人在这台机器上真正烧掉的时间"**`;
console.log(`LOAD nodes=${la.nodes}→${lb.nodes} foreign=${la.foreign}→${lb.foreign} foreignCpuDeltaMs=${foreignCpu}`);
// Print the block identity before any guard can abort: on a log holding two runs, this is the line that
// shows which run the numbers came from. Without it the tool fails and I cannot tell whether it scoped
// wrong or tripped a legitimate guard.
console.log(`BLOCK parsed from the LAST FINAL GATE banner: rows=${rows.length} GATE_EXIT=${gateExit[1]} window=${window} → ${end}`);
// Whether this run passed `--sync` used to be a sentence I typed. The gate states the flag on its own
// MODE line AND encodes it in which sync stage row appears, so derive it from both and refuse to write
// if the two disagree — an unparsed premise in a section titled "我本人跑的，非转述" is the same class of
// defect I file against the product code. This is a log-only check, so it runs before the filesystem
// guards below: an ordering that lets a byte guard abort first makes this one untestable on a dirty box,
// which is how the tool's own prose stayed unchecked for four waves.
const modeSync = /^MODE: .*--sync \(installed copies WRITTEN\)/m.test(table);
const rowSync = rows.some((l) => l.includes("sync deployed copies"));
const rowDry = rows.some((l) => l.includes("match repo (dry)"));
if (modeSync !== rowSync || modeSync === rowDry) {
  fail(`the --sync premise contradicts itself: MODE says ${modeSync}, rows say ${JSON.stringify(rowSync)}/${JSON.stringify(rowDry)}`);
}
const syncFlag = modeSync;
console.log(`PREMISE --sync=${syncFlag} (MODE line and stage row agree)`);

const grab = (needle, what) => {
  const hit = rows.find((l) => l.includes(needle));
  if (!hit) fail(`no stage row matching ${JSON.stringify(needle)} (${what})`);
  return hit;
};
const tally = (row, label) => {
  const m = /tests=(\d+) pass=(\d+) fail=(\d+) skip=(\d+)/.exec(row);
  if (!m) fail(`${label}: the stage printed no tally, so its green means nothing here`);
  if (Number(m[3]) !== 0) fail(`${label} reports ${m[3]} failures`);
  return { tests: m[1], pass: m[2], fail: m[3], skip: m[4] };
};
const engine = tally(grab("engine e2e suite", "engine suite"), "engine suite");
const ts = tally(grab("TS suite", "TS suite"), "TS suite");
const models = rows.filter((l) => /model cycle/.test(l)).length;
if (models !== 3) fail(`expected 3 model-cycle stages (TS live + 2 deployed), saw ${models}`);
// The section says "the installed copies already carried this hash before the run", so the hash has to be
// measured here rather than typed: a hand-written value goes stale the first time the engine is edited, and
// then the sentence is a lie that still parses. `mtime <= GATE_START` is the other half — a repo engine
// written *during* the window would mean this run never saw those bytes.
const REPO_ENGINE = "G:/zcode-project/llm-verify/dsh-llm-verifier/minimax-code-plugin/.minimax-plugin/mcp-server.mjs";
const INSTALLED_ENGINES = [
  "C:/Users/datoo/.zcode/skills/llm-verifier/mcp-server.mjs",
  "C:/Users/datoo/.minimax/plugins/llm-verifier/.minimax-plugin/mcp-server.mjs",
];
const nsha = (p) => crypto.createHash("sha256")
  .update(fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 12);
const engineHash = nsha(REPO_ENGINE);
if (new Date(fs.statSync(REPO_ENGINE).mtime) > new Date(window)) {
  fail("the repo engine was written DURING the gate window, so this run is not a witness to its current bytes");
}
for (const p of INSTALLED_ENGINES) {
  if (nsha(p) !== engineHash) fail(`installed copy ${p} is ${nsha(p)}, repo is ${engineHash} — the "sync wrote nothing" sentence below would be false`);
}
// Whether `--sync` actually moved bytes is NOT inferable from a green run: the sync tool prints
// `DEPLOYMENT IN SYNC` both when it wrote nothing and after it copies. The filesystem knows, so ask it —
// an installed copy whose mtime predates GATE_START was untouched by this run.
const syncCopied = INSTALLED_ENGINES.filter((p) => new Date(fs.statSync(p).mtime) > new Date(window)).length;
const syncNote = syncCopied === 0
  ? `这一跑**没有搬运任何字节**：两份安装副本的 mtime 都早于 \`GATE_START\`（0/${INSTALLED_ENGINES.length} 被写），跑之前它们与仓库就同为 \`${engineHash}\`（EOL 归一后实测，不是回忆）。这反过来让 \`sync-deployed-924.mjs\` 这一条成为\`--sync\` 与不带都成立的最强形态：该工具只在 \`before !== want\` 时才写（\`:27\`），而不带 \`--sync\` 时它根本不写，所以 0 次写入意味着这一条是纯粹的只读对账，于是"部署副本 == 仓库"这句话在这一跑里是真证据，而不是它刚修完自己判绿。阶段序也因此有意义：sync → 宿主注册逐条 \`realpathSync.native\` + 哈希对账 → 部署副本不变量探针 → 部署副本真实模型整轮。`
  : `这一跑**确实写了** ${syncCopied}/${INSTALLED_ENGINES.length} 份安装副本（mtime 晚于 \`GATE_START\`），跑完之后仓库与副本同为 \`${engineHash}\`（EOL 归一后实测）——末尾两条真实模型整轮打的正是刷完之后的字节。代价也要写：真写了的时候，"部署副本漂移"那一条是它刚写完再自己判绿，它**不能**充当"安装副本从没被人动过"的证据；那条证据要么来自某一次 \`--no-sync\` 的跑，要么来自像上一跑那样 \`copied=0\` 的情形。`;

const body = rows.map((l) => {
  const m = /^(PASS|FAIL)\s+(.+?)\s+([\d.]+)s\s+exit=(-?\d+)(?:\s+\[(.*?)\])?(?:\s*(tests=.*?))?\s*$/.exec(l.trimEnd());
  if (!m) return `| (unparsed row) | | | | ${l.replace(/\|/g, "\\|")} |`;
  return `| ${m[2]} | ${m[1] === "PASS" ? "PASS" : "**FAIL**"} | ${m[3]} s | exit ${m[4]} | ${(m[5] ?? "")}${m[5] && m[6] ? " · " : ""}${m[6] ?? ""} |`;
});

// (MODE-line / stage-row derivation of the --sync premise lives up with the other log-only guards.)
if (!syncFlag && syncCopied > 0) {
  fail(`this run never passed --sync yet ${syncCopied}/${INSTALLED_ENGINES.length} installed copies were written inside its window — something else moved them; do not describe this as a read-only reconciliation`);
}
const premise = syncFlag
  ? `**这一跑带 \`--sync\`**（门禁自身的 \`MODE:\` 行与被跑的 sync 阶段名两路对账一致）。${syncNote}`
  : `**这一跑不带 \`--sync\`**（门禁 \`MODE:\` 行与阶段名 \`deployed copies match repo (dry)\` 两路一致）：安装副本是更早某一次 \`--sync\` 写进去的，这一跑只做哈希对账。${syncNote}`;
const headSync = syncFlag
  ? (syncCopied === 0
      ? `带 --sync 但写入安装副本 0/${INSTALLED_ENGINES.length} 份（mtime 均早于 GATE_START），所以这一跑里"部署副本==仓库"那条是**纯只读对账**，证明力不弱于干跑`
      : `带 --sync 且写入安装副本 ${syncCopied}/${INSTALLED_ENGINES.length} 份（mtime 晚于 GATE_START），末尾两条真实模型整轮打的正是刷完之后的字节`)
  : `不带 --sync（该阶段是干跑对账），安装副本本跑一次都没被写（mtime 均早于 GATE_START，0/${INSTALLED_ENGINES.length}）⇒ "部署副本==仓库"在这一跑里是纯观测`;
const section = `## 最终门禁（波次 ${WAVE} 之后，${new Date(window).toISOString().slice(0, 16).replace("T", " ")} UTC 起的那一跑，负载实测见下，我本人跑的，非转述）

**这一跑不是在独占的机器上跑的，而且我把这件事量了**：门禁自己在首尾各采样一次 node 进程，${loadNote} 早先的台账把窗口写成"全静默"，那是我自己手写的声明、没有任何一行读数支撑它（[[handwritten-declaration-is-unchecked-decoration]]）。现在判据改由门禁给出：窗口内**外来** node 的累计 CPU 毫秒差才是负载，红了好归因，绿了也知道绿在什么环境里。

一条前提先说清楚，因为它决定这张表能证明什么：${premise}

覆盖面必须按层说，否则会对 TS 那一半过度声明：**本波（N31 + 波次 24 的四把引擎侧收口刀）的宿主可见面只有 \`.mjs\`**。宿主加载的是 \`sync-deployed-924.mjs:10-11\` 那两个目标（ZCode 与 JCode 共用其中一份），而 \`src/core.ts\` 的那半边**不落进任何安装目录**——它的真实环境验证是门禁的 TS 阶段与直接驱动 \`lib/\` 的真 git 审计，不是"某个宿主跑到了新代码"。所以"引擎已同步"这句话不等于"修复已到达宿主"。

第二前提：**这一跑全程串行，而时序敏感的 TS 套件被放在第 4 个阶段**（它前面只有 typecheck / build / audit 三步，约 8 秒），65 秒的排水间隔现在睡在引擎套件之后，护的是末尾两条计费的真机模型整轮。换顺序是量出来的，不是审美：波次 22b 与波次 26 两次，紧跟 852 s 引擎套件起跑的 TS 阶段都有测红落在候选/验证预算上（26 那一跑里同一条命令在窗口内 973.5 s 且 3 红，单独跑 748.8 s 且 0 红），而引擎套件末尾会杀掉引擎进程、引擎自身关闭等待上限 60 s——65 秒的间隔不足以让那截尾巴跑完，所以判据只能改成"别让敏感阶段排在尾巴后面"。同一波另把夹具预算从 10/10/30 s 抬到 60/60/180 s，**没有任何判据被放宽**：抬的只是对机器的耐心，而"到点会被掐"这件事另有三处自带小预算的对照仍在被证明（\`process.test.ts:63\`、\`reviewer.test.ts:98\`、\`core.integration.test.ts:720\`）。

下表由 \`fill-table-924.mjs\` 从门禁自己的输出**解析生成**（任一读数解析不到即中止，不写入任何我抄的数字）：

| 阶段 | 结果 | 耗时 | 退出码 | 读数 |
|---|---|---|---|---|
${body.join("\n")}

合计 ${rows.length} 个阶段（与门禁自报 \`stages run: ${declared[1]}\` 相符；两者不符这个脚本就不会落笔），\`GATE_EXIT=${gateExit[1]}\`，起止 ${window} → ${end}。真实模型整轮 ${models} 条（TS 层 1 + 两份安装副本各 1）。

覆盖面而不是数字才是要看的：引擎套件 ${engine.tests} 项（${engine.pass} 通过 / ${engine.fail} 失败 / ${engine.skip} skip），TS 套件 ${ts.tests} 项（${ts.pass} / ${ts.fail} / ${ts.skip}）。逐波增量不在本行枚举，两次权威跑各自成立——波次 19 那跑是 50 与 111，波次 23 那跑是 52 与 115，那一段涨出来的两对是 N31 的收口测：引擎侧 S21/S22（死线到期时，一个被打断的 \`mcode_model\` 评审必须判 \`timeout\`；而已有幸存者的 \`parent_agent\` 必须照常给判决并落 \`winner.patch\`），TS 侧 4 条（死线落在**清理阶段**之后仍要保住胜者与 \`winnerPatchPath\`、保住 \`review_pending\`、已付费的评审不得被重新拉起、\`parent_agent\` 交接必须带上原因）。这两对测是有牙齿的：把引擎的判决门删窄会只红 S22，删掉评审例外会只红 S21（\`docs/proof/logs/924/mut-engine-*.log\`）。此后各波（20/21/22/23/24/24b/25）新增了什么测，在各自「波次 NN 落地」小节逐条点名，本表不重述，免得用一次旧枚举冒充当前覆盖面。TS 的 ${ts.skip} 条 skip 仍是 POSIX-only 分支（\`/proc\` 与 SIGKILL 组清理），不是被跳掉的判据。

T-F7 的**耗时**读数不在这张表里：门禁的 TS 阶段只回收 tests/pass/fail/skip，\`[T-F7]\` 那行打进 stdout 后被阶段的标记提取吃掉。耗时数字单独在静默窗口跑 \`node --test --test-name-pattern="spawn shape" tests/git.test.ts\` 量一次，写在「波次 18 的 TS 腿」那张表里，不混进这张表冒充门禁读数。

`;

let lines = fs.readFileSync(DOC, "utf8").split("\n");

// --- rewrite the headline 交付状态 paragraph from the same parse -------------
const headIdx = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith("交付状态（")).map(([, i]) => i);
if (headIdx.length !== 1) fail(`expected exactly one 交付状态 headline line, found ${headIdx.length}`);
// Count the items still open for 主上 in the residual table, instead of asserting a number
// I remember. The scan is bounded to that one table block on purpose.
const start = lines.findIndex((l) => l === "## 残余清单（owner + 主上，不虚报为零）") >= 0
  ? lines.findIndex((l) => l === "## 残余清单（owner + 主上，不虚报为零）")
  : lines.findIndex((l) => l.startsWith("## 残余清单"));
if (start < 0) fail("residual-list heading not found; the open-item count cannot be derived");
let stop = start + 1;
while (stop < lines.length && !lines[stop].startsWith("## ")) stop += 1;
const residual = lines.slice(start, stop).filter((l) => l.startsWith("|"));
// Column-index parsing is not good enough here: one of these rows contains an escaped pipe (`3\|5`),
// which shifts every later cell and silently dropped it from the old positional test — an
// undercount in the one sentence whose whole point is "I am not hiding the open items". So: match
// the OPEN verdict itself, then look for 主上 in the ~80 chars right after it (the verdict + owner
// columns), and PRINT the matched items so the number can be eyeballed instead of trusted.
// `\*\*?` would NOT mean "zero or two asterisks" — it demands at least one, which hid the two rows whose
// verdict is a bare `OPEN` (one of them owner=主上). Non-capturing optional pair is the honest form.
const openHere = residual.filter((l) => /(^|\|)\s*(?:\*\*)?OPEN\b/.test(l) && !/\|\s*(?:\*\*)?CLOSED/.test(l));
const bossRows = openHere.filter((l) => /主上/.test((l.split(/OPEN/)[1] ?? "").slice(0, 80)));
const openForBoss = bossRows.length;
const joint = bossRows.filter((l) => /我\s*\/\s*主上/.test(l.slice(0, 400))).length;
if (openForBoss === 0) fail("no OPEN/主上 row parsed — either the table shape changed or the count is vacuous");
console.log(`OPEN rows in the residual block: ${openHere.length}; owner-touching 主上: ${openForBoss} (joint 我/主上: ${joint})`);
for (const l of bossRows) console.log("  - " + l.replace(/^\|\s*/, "").slice(0, 52));
lines[headIdx[0]] = `交付状态（波次 ${WAVE} 收尾，` + new Date(window).toISOString().slice(0, 16).replace("T", " ") + " UTC 那一跑）：G0/G1 全部落地，并且**终审门禁 "
  + rows.length + " 个阶段一次全 PASS、`GATE_EXIT=" + gateExit[1] + "`**（这一跑" + (syncFlag ? "带" : "不带") + " `--sync`，" + headSync + "；引擎与两份副本归一后同为 `" + engineHash + "`。宿主可见面只有 `.mjs`，`src/core.ts` 那半边不落进任何安装目录，其真实环境验证走门禁 TS 阶段与 `lib/` 直驱审计），含真实模型整轮 " + models + " 条（TS 层 1 + 两份安装副本各 1）、引擎 e2e "
  + engine.tests + " 项（" + engine.pass + " 通过 / " + engine.skip + " skip）、TS " + ts.tests + " 项（" + ts.pass + " 通过 / " + ts.skip
  + " skip，skip 是 POSIX 分支）。逐阶段读数见「最终门禁（波次 " + WAVE + " 之后）」一节；那张表由脚本从门禁输出解析生成，不是我抄的。**没有虚报为零**：owner 触及主上的 "
  + openForBoss + " 条 OPEN 项（其中 " + joint + " 条是我/主上共管），加「宿主重启后才加载已同步的引擎」，逐条在「残余清单」里带触发条件。";

// --- splice the new section --------------------------------------------------
if (lines.filter((l) => l === ANCHOR).length !== 1) fail("anchor is not unique in 924.md");
const at = lines.indexOf(ANCHOR);
const frag = section.replace(/\n+$/, "").split("\n");
// Two of the three self-checks that used to sit here were identities: `out` is BUILT from `lines` + `frag`,
// so neither its line delta nor its heading count can ever disagree with themselves. The failures that can
// actually happen are (a) running this tool twice, which publishes two 最终门禁 blocks for one wave and
// prints WROTE both times, and (b) dying mid-write on a 360 KB hand-edited ledger that has no VCS history
// to fall back on. So: look for an existing section for this wave, and write through temp + rename with a
// read-back compare.
if (lines.some((l) => l.startsWith(`## 最终门禁（波次 ${WAVE} 之后`))) {
  fail(`a 波次-${WAVE} 最终门禁 section is already in the ledger — replacing it is a deliberate edit, not a re-run of this script`);
}
const out = [...lines.slice(0, at), ...frag, "", ...lines.slice(at)];
if (out.filter((l) => l.startsWith(`## 最终门禁（波次 ${WAVE} 之后`)).length !== 1) fail("the new section heading is not present exactly once after the splice");
if (out.filter((l) => l.startsWith("交付状态（")).length !== 1) fail("the headline is not exactly one line after the rewrite");
if (out.some((l) => /__[A-Z0-9_]+__/.test(l))) fail("an unfilled placeholder survived");
if (!out.some((l) => l.startsWith(`交付状态（波次 ${WAVE}`))) fail("headline rewrite did not land");
const tmp = `${DOC}.tmp`;
fs.writeFileSync(tmp, out.join("\n"));
if (fs.readFileSync(tmp, "utf8") !== out.join("\n")) fail("the temp copy does not match what was meant to be written — nothing was replaced");
fs.renameSync(tmp, DOC);
console.log(`WROTE rows=${rows.length} stages=${declared[1]} engine=${engine.tests} ts=${ts.tests} models=${models} openForBoss=${openForBoss} exit=${gateExit[1]}`);
