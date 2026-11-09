/**
 * /caffeinate: keep the computer awake, like macOS's `caffeinate`.
 *
 *   /caffeinate            toggle (on until you turn it off)
 *   /caffeinate 2h | 90m   on for that long
 *   /caffeinate display    also keep the screen on
 *   /caffeinate off        let it sleep again
 *
 * The desktop app uses Electron's powerSaveBlocker; the terminal app runs the
 * real `caffeinate` on macOS (systemd-inhibit on Linux).
 */

export interface CaffeinateRequest {
  action: "toggle" | "on" | "off" | "status";
  /** Milliseconds, or null for "until turned off". */
  durationMs: number | null;
  /** Keep the screen on too (not just the system). */
  display: boolean;
}

export interface CaffeinateStatus {
  on: boolean;
  display: boolean;
  /** When it turns itself off (ms), or null. */
  until: number | null;
}

/** Parse what follows /caffeinate. Throws with a usage line on anything else. */
export function parseCaffeinate(arg: string): CaffeinateRequest {
  const words = arg.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const req: CaffeinateRequest = { action: words.length ? "on" : "toggle", durationMs: null, display: false };
  for (const w of words) {
    if (w === "off" || w === "stop") req.action = "off";
    else if (w === "status") req.action = "status";
    else if (w === "on") req.action = "on";
    else if (w === "display" || w === "screen" || w === "-d") req.display = true;
    else {
      const m = w.match(/^(\d+(?:\.\d+)?)(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)?$/);
      if (!m) throw new Error("Usage: /caffeinate [off | 30m | 2h | display]");
      const n = Number(m[1]);
      const unit = (m[2] ?? "m")[0];
      req.durationMs = Math.round(n * (unit === "h" ? 3_600_000 : unit === "s" ? 1000 : 60_000));
      if (req.durationMs <= 0) throw new Error("Give a duration above zero, e.g. /caffeinate 30m");
    }
  }
  return req;
}

/** "Keeping this Mac awake for 1h 30m (screen too)." and friends. */
export function describeCaffeinate(s: CaffeinateStatus, now = Date.now()): string {
  if (!s.on) return "Caffeinate is off: the computer can sleep as usual.";
  const what = s.display ? "the computer and screen" : "the computer";
  if (!s.until) return `Keeping ${what} awake until you run /caffeinate off.`;
  const mins = Math.max(1, Math.round((s.until - now) / 60_000));
  const left = mins >= 60 ? `${Math.floor(mins / 60)}h${mins % 60 ? ` ${mins % 60}m` : ""}` : `${mins}m`;
  return `Keeping ${what} awake for ${left} more.`;
}
