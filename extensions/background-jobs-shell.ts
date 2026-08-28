export interface BackgroundShellCommand {
  executable: string;
  args: string[];
}

/**
 * Build the shell invocation used by bg_run. cmd.exe has different redirect
 * and exit-code syntax from bash, so never run POSIX shell wrappers on Windows.
 */
export function backgroundShellCommand(
  command: string,
  logFile: string,
  platform = process.platform,
  _comspec = process.env.ComSpec,
  windowsRunnerPath?: string,
): BackgroundShellCommand {
  if (platform === "win32") {
    if (!windowsRunnerPath) throw new Error("Windows background runner path is required");
    // A Node wrapper owns cmd.exe, logging, and the sentinel. This avoids
    // cmd.exe quoting/redirect edge cases and keeps a killable process tree.
    return { executable: process.execPath, args: [windowsRunnerPath, command, logFile] };
  }

  // A subshell ensures `exit N` in the requested command cannot prevent the
  // sentinel from being written by the wrapper.
  const wrapped = `( ${command} ) &>> ${JSON.stringify(logFile)} ; echo "__BG_EXIT_$?" >> ${JSON.stringify(logFile)}`;
  return { executable: "/bin/bash", args: ["-c", wrapped] };
}
