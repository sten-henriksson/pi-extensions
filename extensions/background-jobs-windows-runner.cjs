// Detached Windows bg-job wrapper. It runs the requested command with cmd.exe,
// sends all output to the supplied log file, and persists its exit code for
// session re-attachment. Keep this CommonJS file directly executable by Node.
const { spawn } = require("node:child_process");
const { appendFileSync, closeSync, openSync } = require("node:fs");

const [command, logFile] = process.argv.slice(2);
if (!command || !logFile) process.exit(2);

const output = openSync(logFile, "a");
const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
  stdio: ["ignore", output, output],
  windowsHide: true,
});

let settled = false;
function finish(code) {
  if (settled) return;
  settled = true;
  closeSync(output);
  appendFileSync(logFile, `__BG_EXIT_${Number.isInteger(code) ? code : -1}\n`);
  process.exit(Number.isInteger(code) ? code : 1);
}

child.once("error", () => finish(-1));
child.once("close", (code) => finish(code));
