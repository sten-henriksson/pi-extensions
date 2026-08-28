import assert from "node:assert/strict";
import test from "node:test";
import { backgroundShellCommand } from "../extensions/background-jobs-shell.ts";

test("background jobs use bash wrapper on POSIX", () => {
  const shell = backgroundShellCommand("exit 7", "/tmp/job.log", "linux");
  assert.equal(shell.executable, "/bin/bash");
  assert.deepEqual(shell.args.slice(0, 1), ["-c"]);
  assert.match(shell.args[1], /^\( exit 7 \) &>> "\/tmp\/job\.log" ; echo "__BG_EXIT_\$\?" >> "\/tmp\/job\.log"$/);
});

test("background jobs use a Node-owned cmd.exe runner on Windows", () => {
  const shell = backgroundShellCommand(
    "exit /b 7",
    "C:\\Temp\\job.log",
    "win32",
    "C:\\Windows\\System32\\cmd.exe",
    "C:\\extension\\background-jobs-windows-runner.cjs",
  );
  assert.equal(shell.executable, process.execPath);
  assert.deepEqual(shell.args, [
    "C:\\extension\\background-jobs-windows-runner.cjs",
    "exit /b 7",
    "C:\\Temp\\job.log",
  ]);
});
