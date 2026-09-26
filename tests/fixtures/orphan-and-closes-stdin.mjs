// Leaves a survivor exactly like orphan-child.mjs, then closes its own read end
// of the stdin pipe. Standing in for a candidate whose `dsh` never reads the
// prompt: the parent's pending stdin write then fails with EPIPE, which is the
// one `runProcess` path that rejects after a real child ran.
//
// argv[2]: a path to write the orphan's pid to, because a rejection discards the
// captured stdout along with the result.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], {
  stdio: "ignore",
  // POSIX: a plain child stays in the root's process group and outlives it.
  // Windows: only a detached child escapes the job object that otherwise takes
  // the whole tree down with the root.
  detached: process.platform === "win32",
  windowsHide: true,
});
child.unref();
const pidPath = process.argv[2];
if (pidPath !== undefined) {
  writeFileSync(pidPath, `${String(child.pid)}\n`);
}
process.stdout.write(`${String(child.pid)}\n`);
// Closing the read end while the parent still has bytes queued is what makes the
// write fail; the 500 ms below keeps the child alive past that failure so
// `settle` sees the error while the process is still there to observe.
process.stdin.destroy();
setTimeout(() => process.exit(0), 500);
