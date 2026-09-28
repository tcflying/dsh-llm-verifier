import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { acquireRepositoryLock } from "../src/core.ts";

// The release returned by acquireRepositoryLock used to `rm` the lock file
// unconditionally. `judgeLock` legally hands a starved lock to a second
// operation, so the first holder's release then deleted the NEW holder's lock
// (found 928 P0-1) - and the comment claiming a "heartbeat check" would reclaim
// stale records described a mechanism that does not exist. These tests pin the
// ownership rule: the file is removed only when it still names this process.
describe("repository lock release is ownership-checked", () => {
  const lockPathFor = (stateDirectory: string, repositoryPath: string) =>
    join(stateDirectory, "locks", `${createHash("sha256").update(repositoryPath).digest("hex")}.lock`);

  const takeoverRecord = (repositoryPath: string) => `${JSON.stringify({
    repositoryPath,
    pid: process.pid + 1,
    hostname: hostname() + "-peer",
    createdAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  })}\n`;

  it("removes the lock file when the record still names this process", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "lock-own-"));
    const repositoryPath = await realpath(stateDirectory);
    try {
      const release = await acquireRepositoryLock(stateDirectory, repositoryPath);
      const lockPath = lockPathFor(stateDirectory, repositoryPath);
      const record = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
      assert.equal(record.pid, process.pid);
      await release();
      await assert.rejects(readFile(lockPath), /ENOENT/u);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("keeps a takeover holder's lock when this holder releases late", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "lock-takeover-"));
    const repositoryPath = await realpath(stateDirectory);
    try {
      const release = await acquireRepositoryLock(stateDirectory, repositoryPath);
      const lockPath = lockPathFor(stateDirectory, repositoryPath);
      // The starved-lock takeover this release must survive: a second operation
      // judged the heartbeat stalled and re-seated, so the file now names it.
      const planted = takeoverRecord(repositoryPath);
      await writeFile(lockPath, planted);
      await release();
      assert.equal(await readFile(lockPath, "utf8"), planted);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it("keeps an unparseable record rather than deleting what it cannot identify", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "lock-torn-"));
    const repositoryPath = await realpath(stateDirectory);
    try {
      const release = await acquireRepositoryLock(stateDirectory, repositoryPath);
      const lockPath = lockPathFor(stateDirectory, repositoryPath);
      // A half-written record is exactly what this holder's own heartbeat
      // rewrite looks like from outside - and also what a takeover in flight
      // looks like. Unidentifiable must not mean removable.
      await writeFile(lockPath, "{\"pid\": process.pi");
      await release();
      assert.equal(await readFile(lockPath, "utf8"), "{\"pid\": process.pi");
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
