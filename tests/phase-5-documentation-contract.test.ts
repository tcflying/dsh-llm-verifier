import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const ENGLISH_README_URL = new URL("../README.md", import.meta.url);
const CHINESE_README_URL = new URL("../README.zh-CN.md", import.meta.url);
const ACCEPTANCE_URL = new URL("../docs/acceptance/phase-5.md", import.meta.url);
const SECURITY_REPORT_URL = new URL(
  "../docs/acceptance/phase-5-security-report.md",
  import.meta.url,
);

async function readDocumentation(): Promise<{
  readonly english: string;
  readonly chinese: string;
}> {
  const [english, chinese] = await Promise.all([
    readFile(ENGLISH_README_URL, "utf8"),
    readFile(CHINESE_README_URL, "utf8"),
  ]);
  return { english, chinese };
}

describe("Phase 5 documentation contract", () => {
  it("provides equivalent English and Chinese Phase 5 boundary sections", async () => {
    const { english, chinese } = await readDocumentation();
    assert.match(english, /^## Phase 5 offline CI and evaluation boundaries$/mu);
    assert.match(chinese, /^## Phase 5 离线 CI 与评测边界$/mu);
    for (const sectionName of ["CI", "Credentials", "Evaluation boundary", "Isolation boundary", "Troubleshooting"]) {
      assert.match(english, new RegExp(`^### ${sectionName}$`, "mu"));
    }
    for (const sectionName of ["CI", "凭据", "评测边界", "隔离边界", "故障排查"]) {
      assert.match(chinese, new RegExp(`^### ${sectionName}$`, "mu"));
    }
  });

  it("states offline evaluation, zero real credential use, and the approval gate in both languages", async () => {
    const { english, chinese } = await readDocumentation();
    assert.match(english, /CI neither reads nor requires a real DeepSeek credential/u);
    assert.match(english, /Offline deterministic tests[\s\S]*Approval required[\s\S]*Real model evaluation/u);
    assert.match(english, /Native Best-of-N and Terminal-Bench evaluation have not been executed/u);
    assert.match(chinese, /CI 不读取、也不需要真实 DeepSeek 凭据/u);
    assert.match(chinese, /离线确定性测试[\s\S]*需要审批[\s\S]*真实模型评测/u);
    assert.match(chinese, /原生 Best-of-N 和 Terminal-Bench 评测均未执行/u);
  });

  it("separates worktree, container, and model execution data in both languages", async () => {
    const { english, chinese } = await readDocumentation();
    for (const boundaryTerm of ["Git worktree", "Docker/container", "Model execution data"]) {
      assert.match(english, new RegExp(boundaryTerm.replace("/", "\\/"), "u"));
    }
    for (const boundaryTerm of ["Git worktree", "Docker/container", "模型执行数据"]) {
      assert.match(chinese, new RegExp(boundaryTerm.replace("/", "\\/"), "u"));
    }
    assert.match(english, /Offline tests collect no model response and upload no execution data/u);
    assert.match(chinese, /离线测试不采集模型响应，也不上传执行数据/u);
  });

  it("documents credential, dependency, timeout, and verifier troubleshooting without bypasses", async () => {
    const { english, chinese } = await readDocumentation();
    for (const problemName of ["Credential detected", "Dependency mismatch", "Timeout", "Verifier failure"]) {
      assert.match(english, new RegExp(`\\| ${problemName} \\|`, "u"));
    }
    for (const problemName of ["检测到凭据", "依赖不匹配", "超时", "Verifier 失败"]) {
      assert.match(chinese, new RegExp(`\\| ${problemName} \\|`, "u"));
    }
    assert.match(english, /instead of bypassing that guard/u);
    assert.match(chinese, /不得绕过门禁/u);
  });

  it("keeps acceptance documents free of premature completion claims", async () => {
    const acceptanceDocuments = (await Promise.all([
      readFile(ACCEPTANCE_URL, "utf8"),
      readFile(SECURITY_REPORT_URL, "utf8"),
    ])).join("\n");
    assert.doesNotMatch(acceptanceDocuments, /\bACCEPT\b/u);
    assert.doesNotMatch(acceptanceDocuments, /\bproduction ready\b/iu);
    assert.doesNotMatch(acceptanceDocuments, /\bfully verified\b/iu);
    assert.doesNotMatch(acceptanceDocuments, /\bPhase 5 complete\b/iu);
    assert.match(acceptanceDocuments, /Hosted CI[^\n]*(?:PENDING|NOT EXECUTED)/u);
  });

  it("reports non-executed image and model evaluation without fabricated results", async () => {
    const securityReport = await readFile(SECURITY_REPORT_URL, "utf8");
    assert.match(securityReport, /`imageDigest` \| N\/A — no evaluation image executed/u);
    assert.match(securityReport, /Model execution \| No live candidate or verifier evaluation \| NOT EXECUTED/u);
    assert.match(securityReport, /Native Best-of-N executions: 0/u);
    assert.match(securityReport, /Terminal-Bench executions: 0/u);
    assert.doesNotMatch(securityReport, /imageDigest[^\n]*sha256:[0-9a-f]{64}/u);
    assert.doesNotMatch(securityReport, /Terminal-Bench result:/u);
  });
});
