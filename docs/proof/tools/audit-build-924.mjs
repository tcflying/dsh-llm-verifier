// 924 build-artifact + cross-implementation parity audit.
//
// This replaced a hand-built-manifest fixture audit whose fixtures rotted as the product schema
// grew ("invalid run manifest ranking: undefined"). The behaviours it used to assert are covered
// properly by tests/rollback.test.ts, which drives the real product (15 tests, including
// "restores both sides of a rename", "refuses to revert files the user edited after the apply",
// "lets only one of two concurrent applies touch the run state"). What nothing else covered:
//   1. does the BUILT artifact (lib/, what a host loads after `pnpm run build`) import at all,
//      and does it still export the tool entry points;
//   2. do the TWO schema layers of this repo agree on the ceilings that keep `setTimeout` out of
//      Node's >2^31-1 ms clamp — the exact shape N11b was filed for.
// Usage: node "%TEMP%/audit-build-924.mjs"   (after `pnpm run build`)
import { existsSync, readFileSync } from "node:fs";

const BUILD = "file:///G:/zcode-project/llm-verify/dsh-llm-verifier/lib/";
const REPO = "G:/zcode-project/llm-verify/dsh-llm-verifier/";
const TIMEOUT_KEYS = ["candidateTimeoutMs", "validationTimeoutMs", "runTimeoutMs"];

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${String(detail).replace(/\r?\n/g, " ").slice(0, 200)}` : ""}`);
  if (!ok) failures += 1;
};
// Verdict-first ordering: a Windows EPERM during scratch cleanup must never mask a conclusion.
const verdict = () => {
  console.log(failures === 0 ? "\nAUDIT OK" : `\nAUDIT FAILURES: ${failures}`);
  process.exit(failures === 0 ? 0 : 1);
};

check("lib/ exists (run `pnpm run build` first)", existsSync(REPO + "lib/core.js"), REPO + "lib/core.js");
if (!existsSync(REPO + "lib/core.js")) verdict();

const core = await import(BUILD + "core.js");
for (const fn of ["runVerifiedBestOf", "selectVerifiedCandidate", "applyVerifiedWinner", "rollbackVerifiedWinner"])
  check(`built lib/core.js exports ${fn}`, typeof core[fn] === "function", typeof core[fn]);

const settings = await import(BUILD + "settings.js");
const { MAX_TIMEOUT_MS: MAX } = await import(BUILD + "config.js");
check("MAX_TIMEOUT_MS is exported from the one shared module", MAX === 604_800_000, String(MAX));

// The portable engine speaks minutes; the two ceilings must be the same wall of time, or the same
// config edit kills one host and not the other.
const engineSrc = readFileSync(REPO + "minimax-code-plugin/.minimax-plugin/mcp-server.mjs", "utf8");
const engineMin = Number(/MAX_TIMEOUT_MIN = ([\d_]+)/.exec(engineSrc)?.[1].replace(/_/g, ""));
check("TS ceiling equals the .mjs ceiling", MAX === engineMin * 60_000, `TS ${MAX} vs .mjs ${engineMin} min`);
check(".mjs refusal names its ceiling symbolically (not a stale literal)",
  /between 1 and \$\{MAX_TIMEOUT_MIN\}/.test(engineSrc));

// Cross-language parity (wave 15 / P7): the python bridge copied the TS verifierModel pattern. A copy
// nobody compares is decoration, so the drift is caught the day someone edits one side. Dialect
// differences (python \Z vs JS $, and JS's leading ^) are normalised; the character class is not.
const pySrc = readFileSync(REPO + "python/verifier_bridge.py", "utf8");
const pyBody = /MODEL_PATTERN = re\.compile\(r"(.+?)"\)/.exec(pySrc)?.[1] ?? "";
const tsBody = /\/(\^.*?)\/u\.test\(value\.verifierModel\)/.exec(readFileSync(REPO + "src/settings.ts", "utf8"))?.[1] ?? "";
check("both verifierModel patterns were extracted from source", pyBody.length > 0 && tsBody.length > 0,
  `py=${JSON.stringify(pyBody)} ts=${JSON.stringify(tsBody)}`);
// The mapping has to be directional. JS `$` (no /m) means "end of string" — that is python's `\Z`.
// Python's `$` also matches before a trailing newline, so a python pattern quietly downgraded to `$`
// would accept "deepseek-v4\n" while settings.ts refuses it — and the old `.replace(/\\Z$/, "$")`
// made the two print as equal. So: prove the python side is `\Z`-anchored, then compare bodies.
const pyEndsStrict = /\\Z$/.test(pyBody);
check("python pattern anchors with \\Z, not $ (the only form equal to a JS /...$/u)", pyEndsStrict,
  `py=${JSON.stringify(pyBody)}`);
check("python and TS verifierModel patterns agree",
  pyEndsStrict && pyBody.slice(0, -2) === tsBody.replace(/^\^/, "").replace(/\$$/, ""),
  `py ${JSON.stringify(pyBody)} vs ts ${JSON.stringify(tsBody)}`);

const hostConfig = await import(BUILD + "index.js").catch((e) => ({ __error: String(e.message) }));
const validate = (schema, value) => schema["~standard"].validate(value);
const issues = (r) => r.issues?.length ?? 0;

const defaults = validate(settings.VerifierSettingsSchema, {}).value;
check("settings schema yields a complete default config", defaults && Object.keys(defaults).length >= 20,
  defaults ? `${Object.keys(defaults).length} fields` : "no value");
for (const k of TIMEOUT_KEYS) {
  check(`default ${k} is inside the ceiling`, defaults[k] > 0 && defaults[k] <= MAX, `${defaults[k]} <= ${MAX}`);
  // A ceiling that only exists in prose is decoration: refuse a value one unit past it,
  // and keep a green control so the relaxation cannot be silent.
  const over = validate(settings.VerifierSettingsSchema, { ...defaults, [k]: MAX + 1 });
  check(`${k} above the ceiling is refused by the settings schema`, issues(over) > 0,
    JSON.stringify(over.issues?.[0]?.message ?? "accepted"));
  check(`${k} exactly at the ceiling is accepted`, issues(validate(settings.VerifierSettingsSchema, { ...defaults, [k]: MAX })) === 0);
}

// The second legal entry point (N11b): host plugin config feeds settingsBaseFrom() and is
// returned untouched by resolveRunSettings() on headless hosts.
if (hostConfig.__error) {
  check("lib/index.js imports", false, hostConfig.__error);
} else {
  const Config = hostConfig.Config ?? hostConfig.default?.Config;
  check("lib/index.js exports the plugin Config schema", !!Config && typeof Config["~standard"] === "object", typeof Config);
  if (Config) for (const k of TIMEOUT_KEYS) {
    check(`plugin Config refuses ${k} above the ceiling`, issues(validate(Config, { [k]: MAX + 1 })) > 0,
      JSON.stringify(validate(Config, { [k]: MAX + 1 }).issues?.[0]?.message ?? "accepted — N11b still open"));
    check(`plugin Config accepts ${k} at the ceiling`, issues(validate(Config, { [k]: MAX })) === 0);
  }
}

// Fail-closed grep: no *TimeoutMs declaration anywhere in the TS layer may carry a lower bound
// without an upper one. Printed as a shape so a future field cannot slip in quietly.
const unbounded = ["src/index.ts", "src/settings.ts"]
  .flatMap((f) => readFileSync(REPO + f, "utf8").split(/\r?\n/).map((l, i) => ({ f, l, at: i + 1 })))
  .filter(({ l }) => /TimeoutMs: z\.natural\(\)\.min\(1\)(?!\.max)/.test(l));
check("no timeout schema field lost its upper bound", unbounded.length === 0,
  unbounded.map((u) => `${u.f}:${u.at}`).join(", "));

// The settings card is a third writer of the same values, and its bounds are hand-written HTML input
// literals that no type check compares to the schema. A card stricter than the schema can display a value
// that config.json or the TS layer legally wrote and then refuse to re-save it — that was verifierMaxTokens
// (card 1024..131072, schema `z.natural().min(1)`) until wave 17. This keeps it from drifting back in
// either direction.
const cardSrc = readFileSync(REPO + "client/client.js", "utf8");
const setSrc2 = readFileSync(REPO + "src/settings.ts", "utf8");
// Four of the six call sites pass no `step` (`numberInput("nEvaluations", 1, 4)`), and the previous
// regex demanded a trailing comma, so it silently compared 2 of 6 and printed n=2 — the vacuity guard
// then passed at exactly the broken count. Parse the whole argument list instead, and make the count
// self-derived: extract as many fields as there are call sites, or fail.
const cardFields = [...cardSrc.matchAll(/numberInput\(([^)]*)\)/g)].map((m) => {
  const a = m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
  return { key: a[0], min: Number(a[1]), max: a[2] === "undefined" ? null : Number(a[2]) };
});
const cardCallSites = (cardSrc.match(/numberInput\(/g) || []).length;
check("every numberInput call site was extracted", cardFields.length === cardCallSites && cardCallSites > 0,
  `extracted ${cardFields.length} of ${cardCallSites} call sites`);
// Both numeric entry points (the plain number box and the minutes box) must test integrality themselves:
// every field they feed is a z.natural(), so a pasted 3.5 has to be refused by the card, not by the schema.
// Counting occurrences globally would be over-tight (the two inbound-value guards below are a different
// concern), so the check is per entry point and goes red if either one drops its test.
for (const entry of ["numberInput", "minutesField"]) {
  check(`card entry point ${entry} tests integrality`,
    new RegExp(`const ${entry} = [\\s\\S]{0,1200}?Number\\.isInteger`).test(cardSrc), "no Number.isInteger in its body");
}
for (const f of cardFields) {
  const key = f.key;
  const decl = new RegExp(`^\\s*${key}:\\s*z\\.(\\w+)\\(\\)([^,\\n]*)`, "m").exec(setSrc2);
  if (!decl) { check(`${key} is declared in settings.ts`, false, "no schema line matched"); continue; }
  const bound = (which) => {
    const b = new RegExp(`\\.${which}\\(([\\d_]+)\\)`).exec(decl[2]);
    if (b) return Number(b[1].replace(/_/g, ""));
    return which === "min" && decl[1] === "natural" ? 0 : null;
  };
  check(`${key}: card min === schema min`, f.min === bound("min"), `card ${f.min} vs schema ${bound("min")}`);
  check(`${key}: card max === schema max (null = unbounded)`, f.max === bound("max"), `card ${f.max} vs schema ${bound("max")}`);
}

verdict();
