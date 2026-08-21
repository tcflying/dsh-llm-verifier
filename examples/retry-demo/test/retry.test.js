import assert from "node:assert/strict";
import test from "node:test";

import { retry } from "../src/retry.js";

test("returns the first successful result and exposes a one-based attempt number", async () => {
  const attempts = [];
  const result = await retry(async (attempt) => {
    attempts.push(attempt);
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(attempts, [1]);
});

test("allows success on the final configured attempt", async () => {
  const attempts = [];
  const result = await retry(async (attempt) => {
    attempts.push(attempt);
    if (attempt < 3) {
      throw new Error(`transient-${attempt}`);
    }
    return "recovered";
  }, { maxAttempts: 3 });

  assert.equal(result, "recovered");
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("never exceeds the configured attempt budget", async () => {
  let calls = 0;

  await assert.rejects(
    retry(async () => {
      calls += 1;
      throw new Error("still failing");
    }, { maxAttempts: 3 }),
    /still failing/,
  );

  assert.equal(calls, 3);
});

test("rejects invalid attempt budgets", async () => {
  await assert.rejects(retry(async () => "unused", { maxAttempts: 0 }), {
    name: "RangeError",
    message: "maxAttempts must be a positive integer",
  });
});
