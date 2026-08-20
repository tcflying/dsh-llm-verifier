import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeCandidateCount } from "../src/config.ts";

describe("verified_best_of candidate count", () => {
  it("defaults to three and accepts only three or five", () => {
    assert.equal(normalizeCandidateCount(undefined, 3), 3);
    assert.equal(normalizeCandidateCount(3, 5), 3);
    assert.equal(normalizeCandidateCount(5, 3), 5);
    assert.throws(
      () => normalizeCandidateCount(4, 3),
      /invalid candidateCount: expected 3 or 5, got 4/,
    );
  });
});
