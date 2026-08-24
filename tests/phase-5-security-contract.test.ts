import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const CI_WORKFLOW_URL = new URL("../.github/workflows/ci.yml", import.meta.url);
const FORBIDDEN_CREDENTIAL_NAMES = [
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENAI_API_KEY",
] as const;
const PHASE_5_FILE_URLS = [
  CI_WORKFLOW_URL,
  new URL("./phase-5-approval-denial-contract.test.ts", import.meta.url),
  new URL("./phase-5-ci-contract.test.ts", import.meta.url),
  new URL("./phase-5-deterministic-matrix.test.ts", import.meta.url),
  new URL("./phase-5-security-contract.test.ts", import.meta.url),
  new URL("../docs/acceptance/phase-5.md", import.meta.url),
  new URL("../docs/acceptance/phase-5-evidence-template.md", import.meta.url),
  new URL("../docs/acceptance/phase-5-security-report.md", import.meta.url),
  new URL("../README.md", import.meta.url),
  new URL("../README.zh-CN.md", import.meta.url),
] as const;

function credentialGuardResult(environment: Readonly<Record<string, string | undefined>>) {
  const forbiddenNames = FORBIDDEN_CREDENTIAL_NAMES
    .filter((credentialName) => Object.hasOwn(environment, credentialName))
    .sort();
  if (forbiddenNames.length === 0) {
    return { exitCode: 0, stdout: "", stderr: "" } as const;
  }
  return {
    exitCode: 2,
    stdout: "",
    stderr: `credential_environment_forbidden: ${forbiddenNames.join(",")}\n`,
  } as const;
}

function privacyFindings(text: string): string[] {
  const findings: string[] = [];
  if (/(?:^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{16,}/u.test(text)) {
    findings.push("api_key_pattern");
  }
  if (/\bBearer\s+[A-Za-z0-9._~+/-]{12,}/u.test(text)) {
    findings.push("bearer_token_pattern");
  }
  if (/-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/u.test(text)) {
    findings.push("private_key_header_pattern");
  }
  if (/\b(?:password|passwd|pwd)\s*[:=]\s*["']?[^\s"']{8,}/iu.test(text)) {
    findings.push("password_assignment_pattern");
  }
  return findings;
}

describe("Phase 5 security and privacy contract", () => {
  it("keeps CI free of secret references, credential names, downloads, Docker pulls, and publishing", async () => {
    const workflow = await readFile(CI_WORKFLOW_URL, "utf8");
    const forbiddenPatterns = [
      /\$\{\{\s*secrets\./u,
      /\$\{\{\s*vars\./u,
      /DEEPSEEK_API_KEY/u,
      /OPENAI_API_KEY/u,
      /ANTHROPIC_API_KEY/u,
      /\bcurl\b/u,
      /\bwget\b/u,
      /docker\s+(?:login|pull)\b/u,
      /(?:npm|pnpm)\s+publish\b/u,
    ];
    for (const forbiddenPattern of forbiddenPatterns) {
      assert.doesNotMatch(workflow, forbiddenPattern);
    }
    assert.match(workflow, /permissions:\n  contents: read/u);
    assert.match(workflow, /persist-credentials: false/u);
  });

  it("reports only sorted credential names and never reads values into failure output", () => {
    const firstSentinel = "credential-value-that-must-not-appear-one";
    const secondSentinel = "credential-value-that-must-not-appear-two";
    const failure = credentialGuardResult({
      OPENAI_API_KEY: firstSentinel,
      ANTHROPIC_API_KEY: "",
      DEEPSEEK_API_KEY: secondSentinel,
    });
    assert.deepEqual(failure, {
      exitCode: 2,
      stdout: "",
      stderr: "credential_environment_forbidden: ANTHROPIC_API_KEY,DEEPSEEK_API_KEY,OPENAI_API_KEY\n",
    });
    assert.doesNotMatch(failure.stderr, new RegExp(firstSentinel, "u"));
    assert.doesNotMatch(failure.stderr, new RegExp(secondSentinel, "u"));
    assert.doesNotMatch(failure.stderr, /length|hash|prefix/iu);
    assert.equal(failure.stderr.split("\n").filter(Boolean).length, 1);
  });

  it("accepts a minimal environment with unrelated fixture identifiers", () => {
    assert.deepEqual(
      credentialGuardResult({ PATH: "/synthetic/bin", PHASE_5_FIXTURE_ID: "fixture-001" }),
      { exitCode: 0, stdout: "", stderr: "" },
    );
  });

  it("rejects API keys, bearer tokens, private-key headers, and password assignments", () => {
    const syntheticCases = [
      { expected: "api_key_pattern", value: ["sk", "phase5synthetickey0123456789"].join("-") },
      { expected: "bearer_token_pattern", value: ["Bearer", "phase5.synthetic.token"].join(" ") },
      { expected: "private_key_header_pattern", value: ["-----BEGIN", "PRIVATE KEY-----"].join(" ") },
      { expected: "password_assignment_pattern", value: `${["pass", "word"].join("")}=${"phase5syntheticvalue"}` },
    ];
    for (const syntheticCase of syntheticCases) {
      assert.deepEqual(privacyFindings(syntheticCase.value), [syntheticCase.expected]);
    }
  });

  it("allows ordinary documentation, stable error codes, and fixture identifiers", () => {
    const benignText = [
      "API key names are documented without values.",
      "credential_environment_forbidden is a stable error code.",
      "phase-5-fixture-001 is a synthetic fixture identifier.",
      "Bearer use is prohibited in offline CI.",
    ].join("\n");
    assert.deepEqual(privacyFindings(benignText), []);
  });

  it("finds no credential-like values in the complete Phase 5 file set", async () => {
    for (const phase5FileUrl of PHASE_5_FILE_URLS) {
      const fileContents = await readFile(phase5FileUrl, "utf8");
      assert.deepEqual(
        privacyFindings(fileContents),
        [],
        `privacy findings in ${phase5FileUrl.pathname.split("/").at(-1) ?? "unknown file"}`,
      );
    }
  });
});
