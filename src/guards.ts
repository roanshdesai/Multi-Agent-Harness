import { execSync } from "node:child_process";
import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessConfig } from "./config.js";

export type Ask = (question: string) => Promise<string>;

/** GitHub MCP tools that publish to a remote. */
const GITHUB_WRITE_TOOLS =
  /^mcp__github__(push_files|create_or_update_file|delete_file|create_branch|create_pull_request|merge_pull_request|update_pull_request_branch|create_repository|fork_repository)$/;

/** Returns the branches a `git push` command would update, or null if it is not a push. */
function currentBranch(dir: string): string {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, encoding: "utf8" }).trim();
  } catch {
    return "(current branch)";
  }
}

/**
 * Branches every `git push` in a command line would update, or null if there's no push.
 * Handles chained commands (; && || | newlines), global options (git -C dir -c k=v push),
 * HEAD/@ refspecs, and --all/--mirror (treated as touching every branch, including main).
 */
export function pushTargets(cmd: string, cwd: string): string[] | null {
  const targets: string[] = [];
  let found = false;
  for (const seg of cmd.split(/[;&|\n]+/)) {
    const m = seg.match(/\bgit((?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?))*)\s+push\b(.*)/);
    if (!m) continue;
    found = true;
    const dir = m[1].match(/-C\s+(\S+)/)?.[1] ?? cwd;
    const rest = m[2].trim().split(/\s+/).filter(Boolean);
    if (rest.some((a) => a === "--all" || a === "--mirror")) {
      targets.push("main", "master");
      continue;
    }
    const args = rest.filter((a) => !a.startsWith("-"));
    const refspecs = args.slice(1).map((r) => (r.includes(":") ? r.split(":")[1] || r.split(":")[0] : r));
    if (!refspecs.length) targets.push(currentBranch(dir));
    for (const r of refspecs) targets.push(r === "HEAD" || r === "@" ? currentBranch(dir) : r);
  }
  return found ? targets : null;
}

/** gh commands that publish to GitHub (merging PRs, raw write API calls). */
function ghWrite(cmd: string): string | null {
  for (const seg of cmd.split(/[;&|\n]+/)) {
    if (/\bgh\s+pr\s+(merge|create)\b/.test(seg)) return seg.trim();
    if (/\bgh\s+api\b/.test(seg) && /(-X|--method)\s*(POST|PUT|PATCH|DELETE)\b/i.test(seg)) return seg.trim();
  }
  return null;
}

function isProtected(branch: string, cfg: HarnessConfig): boolean {
  const b = branch.replace(/^refs\/heads\//, "").replace(/^\+/, "");
  return cfg.approvals.protected_branches.includes(b);
}

const deny = (reason: string): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
});
const allow = (): HookJSONOutput => ({
  hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
});

/**
 * The only human approval in the harness: anything that pushes to GitHub.
 * Pushes to protected branches (main/master) are refused outright.
 */
export function pushApprovalHook(cfg: HarnessConfig, ask: Ask): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PreToolUse") return {};
        const toolInput = (input.tool_input ?? {}) as Record<string, any>;
        let description: string | null = null;

        if (input.tool_name === "Bash" || input.tool_name === "PowerShell") {
          const cmd = String(toolInput.command ?? "");
          const targets = pushTargets(cmd, input.cwd);
          const gh = ghWrite(cmd);
          if (targets === null && !gh) return {};
          if (targets === null) {
            if (/\bgh\s+pr\s+merge\b[\s\S]*\b(main|master)\b/.test(gh!) || /--admin\b/.test(gh!)) return deny("Merging with admin override or into a protected branch is blocked.");
            description = `GitHub write via gh\n  $ ${gh}`;
            if (cfg.approvals.github_push === "allow") return allow();
            if (cfg.approvals.github_push === "deny") return deny("GitHub pushes are disabled in harness.config.yaml.");
            const a = (await ask(`\n⚠  Approve GitHub action?\n  ${description}\n  [y/N] `)).trim().toLowerCase();
            return a === "y" || a === "yes" ? allow() : deny("The user declined this GitHub action.");
          }
          const target = targets.join(", ");
          if (targets.some((t) => isProtected(t, cfg))) {
            return deny(`Pushing to a protected branch (${cfg.approvals.protected_branches.join("/")}) is blocked. Push to a feature branch and open a PR.`);
          }
          description = `git push → ${target}\n  $ ${cmd}`;
        } else if (GITHUB_WRITE_TOOLS.test(input.tool_name)) {
          const branch = String(toolInput.branch ?? toolInput.head ?? "");
          if (branch && isProtected(branch, cfg)) {
            return deny(`Writing directly to protected branch "${branch}" is blocked.`);
          }
          if (input.tool_name.endsWith("merge_pull_request")) {
            const base = String(toolInput.base ?? "");
            description = `merge PR #${toolInput.pullNumber ?? toolInput.pull_number ?? "?"}${base ? ` into ${base}` : ""}`;
          } else {
            description = `${input.tool_name.replace("mcp__github__", "")} ${JSON.stringify(toolInput).slice(0, 300)}`;
          }
        } else {
          return {};
        }

        if (cfg.approvals.github_push === "allow") return allow();
        if (cfg.approvals.github_push === "deny") return deny("GitHub pushes are disabled in harness.config.yaml.");
        const answer = (await ask(`\n⚠  Approve GitHub action?\n  ${description}\n  [y/N] `)).trim().toLowerCase();
        return answer === "y" || answer === "yes" ? allow() : deny("The user declined this GitHub action.");
      },
    ],
  };
}

/**
 * Stuck detector: after N consecutive tool failures, tell the agent to consult
 * the Fable advisor before trying again.
 */
export function stuckDetector(cfg: HarnessConfig) {
  let failures = 0;
  const onFailure: HookCallbackMatcher = {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== "PostToolUseFailure" || input.is_interrupt) return {};
        failures++;
        if (failures < cfg.stuck_after_failures) return {};
        failures = 0;
        return {
          hookSpecificOutput: {
            hookEventName: "PostToolUseFailure",
            additionalContext: `You have hit ${cfg.stuck_after_failures} tool failures in a row (latest: ${input.error.slice(0, 400)}). Stop retrying. Delegate to the "advisor" agent now with the goal, what you tried and the exact errors, then follow its plan.`,
          },
        };
      },
    ],
  };
  const onSuccess: HookCallbackMatcher = {
    hooks: [
      async () => {
        failures = 0;
        return {};
      },
    ],
  };
  return { onFailure, onSuccess };
}
