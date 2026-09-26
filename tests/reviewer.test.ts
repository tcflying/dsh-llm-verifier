import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_PROCESS_OUTPUT_BYTES } from "../src/process.ts";
import { reviewCandidatesWithDshModel, type LlmRuntimeLike } from "../src/reviewer.ts";

function llmWith(response: string): LlmRuntimeLike {
  return {
    async *stream() {
      yield { type: "text-delta", text: response };
      yield { type: "finish", reason: "stop" };
    },
  };
}

const base = {
  provider: "minimax-cn",
  model: "MiniMax-M3",
  maxTokens: 4096,
  timeoutMs: 30_000,
  signal: new AbortController().signal,
  task: "Fix slugify",
  candidates: [
    { candidateId: "candidate-1", validationStatus: "passed", diffStat: "1 +", changedFiles: ["src/a.js"], diffText: "+a" },
    { candidateId: "candidate-2", validationStatus: "passed", diffStat: "2 +", changedFiles: ["src/a.js"], diffText: "+b" },
  ],
};

describe("dsh_model reviewer", () => {
  it("accepts a well-formed receipt whose top score matches the selection", async () => {
    const receipt = await reviewCandidatesWithDshModel(llmWith(
      '{"scores": {"candidate-1": 70, "candidate-2": 95}, "selected": "candidate-2", "evidence": {"candidate-2": "cleaner"}, "risks": "none"}',
    ), { ...base });
    assert.equal(receipt.selectedId, "candidate-2");
    assert.equal(receipt.scores["candidate-1"], 70);
    assert.equal(receipt.method, "dsh_model");
  });

  it("parses a fenced JSON response", async () => {
    const receipt = await reviewCandidatesWithDshModel(llmWith(
      '```json\n{"scores": {"candidate-1": 90, "candidate-2": 80}, "selected": "candidate-1", "evidence": {}, "risks": ""}\n```',
    ), { ...base });
    assert.equal(receipt.selectedId, "candidate-1");
  });

  it("rejects a selection that contradicts the computed ranking", async () => {
    await assert.rejects(
      () => reviewCandidatesWithDshModel(llmWith(
        '{"scores": {"candidate-1": 70, "candidate-2": 95}, "selected": "candidate-1", "evidence": {}, "risks": ""}',
      ), { ...base }),
      /highest-scored candidate is candidate-2/,
    );
  });

  it("rejects score keys that do not exactly cover the candidates", async () => {
    await assert.rejects(
      () => reviewCandidatesWithDshModel(llmWith(
        '{"scores": {"candidate-1": 70}, "selected": "candidate-1", "evidence": {}, "risks": ""}',
      ), { ...base }),
      /do not exactly cover candidates/,
    );
  });

  it("rejects out-of-range scores", async () => {
    await assert.rejects(
      () => reviewCandidatesWithDshModel(llmWith(
        '{"scores": {"candidate-1": 170, "candidate-2": 95}, "selected": "candidate-1", "evidence": {}, "risks": ""}',
      ), { ...base }),
      /not a finite 0-100 number/,
    );
  });

  it("reports the timeout as the cause and closes the stream it stopped waiting for", async () => {
    // A host stream that ignores `signal` must not turn the failure into
    // "no JSON object", and the losing consumer must not keep reading.
    let closed = false;
    let chunksAfterSettlement = 0;
    const hanging = {
      stream(): AsyncIterable<{ type: string; text?: string }> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<{ type: string; text?: string }>> {
                chunksAfterSettlement += 1;
                return new Promise(() => {});
              },
              return(): Promise<IteratorResult<{ type: string; text?: string }>> {
                closed = true;
                return Promise.resolve({ done: true, value: undefined });
              },
            };
          },
        };
      },
    } as unknown as LlmRuntimeLike;

    await assert.rejects(
      () => reviewCandidatesWithDshModel(hanging, { ...base, timeoutMs: 5 }),
      /review timed out after 5 ms/,
    );
    assert.equal(closed, true);
    assert.equal(chunksAfterSettlement, 1);
  });

  it("refuses a runaway body at the cap instead of growing the string forever", async () => {
    // `maxTokens` is a request and `signal` is already assumed ignorable, so a
    // host that keeps streaming has to meet a ceiling: this accumulator was the
    // one in `src/` with none.
    let chunksStreamed = 0;
    const runaway: LlmRuntimeLike = {
      async *stream() {
        for (let chunk = 0; chunk < 64; chunk += 1) {
          chunksStreamed += 1;
          yield { type: "text-delta", text: "a".repeat(1024 * 1024) };
        }
        yield { type: "finish", reason: "stop" };
      },
    };
    await assert.rejects(
      () => reviewCandidatesWithDshModel(runaway, { ...base }),
      (error: unknown) => {
        const message = String(error);
        assert.match(message, new RegExp(`exceeded the ${MAX_PROCESS_OUTPUT_BYTES} byte`));
        assert.match(message, /MAX_PROCESS_OUTPUT_BYTES/);
        assert.match(message, /full body was not parsed/);
        return true;
      },
    );
    // Refused at the boundary, not after reading the whole 64 MiB.
    assert.ok(chunksStreamed <= 18, `streamed ${chunksStreamed} MiB chunks before refusing`);
  });

  it("still parses an ordinary response beside the capped one", async () => {
    const response = '{"scores": {"candidate-1": 60, "candidate-2": 61}, "selected": "candidate-2", "evidence": {}, "risks": "none"}';
    const receipt = await reviewCandidatesWithDshModel(llmWith(response), { ...base });
    assert.equal(receipt.selectedId, "candidate-2");
    assert.equal(receipt.rawResponseLength, response.length);
  });
});
