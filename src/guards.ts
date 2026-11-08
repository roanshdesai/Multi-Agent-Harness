import { execSync } from "node:child_process";
import type { HookCallbackMatcher, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessConfig } from "./config.js";

export type Ask = (question: string) => Promise<string>;

/** GitHub MCP tools that publish to a remote. */
const GITHUB_WRITE_TOOLS =
  /^mcp__github__(push_files|create_or_update_file|delete_file|create_branch|create_pull_request|merge_pull_request|update_pull_request_branch|create_repository|fork_repository)$/;

/** Returns the branches a `git push` command would update, or null if it is not a push. */
function pushTargets(cmd: string, cwd: string): string[] | null {
  const m = cmd.match(/\bgit\s+(?:-C\s+(\S+)\s+)?push\b(.*)/);
  if (!m) return null;
  const args = m[2].split(/[;&|]/)[0].trim().split(/\s+/).filter((a) => a && !a.startsWith("-"));
  // git push [<remote> [<refspec>...]]
  const refspecs = args.slice(1).map((r) => (r.includes(":") ? r.split(":")[1] : r));
  if (refspecs.length) return refspecs;
  try {
    const head = execSync("git rev-parse --abbrev-ref HEAD", { cwd: m[1] ?? cwd, encoding: "utf8" }).trim();
    return [head];
  } catch {
    return ["(current branch)"];
  }
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

        if (input.tool_name === "Bash") {
          const cmd = String(toolInput.command ?? "");
          const targets = pushTargets(cmd, input.cwd);
          if (targets === null) return {};
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
