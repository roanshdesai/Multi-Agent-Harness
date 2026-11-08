import { spawn, spawnSync } from "node:child_process";

const has = (bin: string) => spawnSync(process.platform === "win32" ? "where" : "which", [bin]).status === 0;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command that starts this harness again, resuming the given chat. */
export function resumeCommand(sessionId: string): string[] {
  return [process.execPath, ...process.execArgv, process.argv[1], "--resume", sessionId];
}

/**
 * Open a brand-new terminal window/tab running the harness on `sessionId`.
 * Returns how it was opened, or null if no terminal could be found.
 */
export function openInNewTerminal(sessionId: string, cwd: string): string | null {
  const argv = resumeCommand(sessionId);
  const line = `cd ${shq(cwd)} && ${argv.map(shq).join(" ")}`;
  const detached = (cmd: string, args: string[]) => {
    spawn(cmd, args, { detached: true, stdio: "ignore", cwd }).unref();
  };

  if (process.env.TMUX) {
    detached("tmux", ["new-window", "-n", `fork-${sessionId.slice(0, 6)}`, line]);
    return "tmux window";
  }
  if (process.platform === "darwin") {
    const app = process.env.TERM_PROGRAM === "iTerm.app" ? "iTerm" : "Terminal";
    const script =
      app === "iTerm"
        ? `tell application "iTerm" to create window with default profile command ${JSON.stringify(`bash -lc ${shq(line)}`)}`
        : `tell application "Terminal" to do script ${JSON.stringify(line)}`;
    detached("osascript", ["-e", script, "-e", `tell application "${app}" to activate`]);
    return `${app} window`;
  }
  if (process.platform === "win32") {
    const cmd = argv.map((a) => `"${a}"`).join(" ");
    if (has("wt")) detached("wt", ["-d", cwd, "cmd", "/k", cmd]);
    else detached("cmd", ["/c", "start", "cmd", "/k", `cd /d "${cwd}" && ${cmd}`]);
    return "Windows terminal";
  }
  const linux: [string, string[]][] = [
    ["x-terminal-emulator", ["-e", "bash", "-lc", line]],
    ["gnome-terminal", ["--", "bash", "-lc", line]],
    ["konsole", ["-e", "bash", "-lc", line]],
    ["kitty", ["bash", "-lc", line]],
    ["alacritty", ["-e", "bash", "-lc", line]],
    ["wezterm", ["start", "--", "bash", "-lc", line]],
    ["xterm", ["-e", "bash", "-lc", line]],
  ];
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    for (const [bin, args] of linux) {
      if (has(bin)) {
        detached(bin, args);
        return `${bin} window`;
      }
    }
  }
  return null;
}
