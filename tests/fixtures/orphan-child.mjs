// Exits 0 after starting a process that outlives it, standing in for a `dsh`
// candidate that leaves a watcher or dev server behind. The child inherits no
// stdio handle, so the root's exit is not held up by it, and Windows keeps
// naming the dead root as that orphan's parent, which is what makes the tree
// walkable from the still-valid handle at exit time.
import { spawn } from "node:child_process";

// argv[2]: stay alive this many ms instead of exiting, so a caller can be killed
// by its own timeout while the orphan is already there.
const hangMs = Number.parseInt(process.argv[2] ?? "0", 10) || 0;

const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], {
  stdio: "ignore",
  // POSIX: a plain child stays in the root's process group and outlives it.
  // Windows: only a detached child escapes the job object that otherwise takes
  // the whole tree down with the root.
  detached: process.platform === "win32",
  windowsHide: true,
});
child.unref();
process.stdout.write(`${String(child.pid)}\n`);
if (hangMs > 0) {
  // Ref'd on purpose: an unref'd timer lets this root exit right away, which would
  // quietly turn the timeout case back into a normal exit.
  setTimeout(() => process.exit(0), hangMs);
} else {
  process.exit(0);
}
