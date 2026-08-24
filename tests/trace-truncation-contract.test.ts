import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import type { TraceSectionMetadata } from "../src/contracts.ts";
import { createTraceEnvelope, renderTraceEnvelope } from "../src/core.ts";
import { createPatchArtifact } from "../src/git.ts";

describe("structured verifier trace truncation contract", () => {
  it("counts and retains binary-like trace content as bytes", () => {
    const traceBytes = Buffer.from([0, 255, 254, 253, 128, 64, 32, 16, 8, 4, 2, 1]);
    const envelope = createTraceEnvelope(traceBytes, 7, [], null);
    traceBytes.fill(9);

    assert.equal(envelope.totalBytes, 12);
    assert.equal(envelope.retainedBytes, 7);
    assert.equal(envelope.truncated, true);
    assert.deepEqual(envelope.head, Buffer.from([0, 255, 254, 253]));
    assert.deepEqual(envelope.tail, Buffer.from([4, 2, 1]));
  });

  it("retains both the opening context and trailing validation evidence", () => {
    const traceBytes = Buffer.from(
      `HEAD-CANDIDATE\n${"x".repeat(256)}\nValidation evidence:\nTAIL-VALIDATION-PASSED`,
      "utf8",
    );
    const envelope = createTraceEnvelope(traceBytes, 80, [], null);
    const renderedTrace = renderTraceEnvelope(envelope);

    assert.match(renderedTrace, /HEAD-CANDIDATE/u);
    assert.match(renderedTrace, /TAIL-VALIDATION-PASSED/u);
    assert.match(renderedTrace, /complete input retained locally/u);
  });

  it("records auditable byte and section metadata", () => {
    const traceBytes = Buffer.from("candidate\n\nvalidation-evidence", "utf8");
    const sections: TraceSectionMetadata[] = [
      { name: "candidate", startByte: 0, endByteExclusive: 9, totalBytes: 9 },
      { name: "validationEvidence", startByte: 11, endByteExclusive: 30, totalBytes: 19 },
    ];
    const envelope = createTraceEnvelope(traceBytes, 12, sections, null);

    assert.deepEqual(
      {
        totalBytes: envelope.totalBytes,
        retainedBytes: envelope.retainedBytes,
        truncated: envelope.truncated,
        headBytes: envelope.head.length,
        tailBytes: envelope.tail.length,
        sections: envelope.sections,
      },
      {
        totalBytes: traceBytes.length,
        retainedBytes: 12,
        truncated: true,
        headBytes: 6,
        tailBytes: 6,
        sections,
      },
    );
  });

  it("associates trace metadata without changing patch artifact identity", () => {
    const artifact = createPatchArtifact(Buffer.from([0, 255, 1, 254, 2, 253]));
    const originalArtifactBytes = Buffer.from(artifact.bytes);
    const envelope = createTraceEnvelope(
      Buffer.from(`artifact=${artifact.sha256}\n${"trace".repeat(40)}`, "utf8"),
      64,
      [],
      artifact.sha256,
    );

    renderTraceEnvelope(envelope);
    assert.equal(envelope.artifactSha256, artifact.sha256);
    assert.deepEqual(artifact.bytes, originalArtifactBytes);
    assert.equal(
      artifact.sha256,
      createHash("sha256").update(originalArtifactBytes).digest("hex"),
    );
  });
});
