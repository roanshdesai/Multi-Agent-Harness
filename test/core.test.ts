import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushApprovalHook } from "../src/guards.js";
import { loadDesignLinks, searchDesignLinks } from "../src/tools/design-library.js";
import { discoverPlugins } from "../src/session.js";
import type { HarnessConfig } from "../src/config.js";

const cfg = { approvals: { github_push: "ask", protected_branches: ["main", "master"] } } as unknown as HarnessConfig;
const signal = new AbortController().signal;

async function decide(tool_name: string, tool_input: unknown, answer = "y") {
  let asked = false;
  const hook = pushApprovalHook(cfg, async () => ((asked = true), answer)).hooks[0];
  const out: any = await hook(
    { hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: process.cwd() } as any,
    "t",
    { signal },
  );
  return { decision: out?.hookSpecificOutput?.permissionDecision ?? "none", asked };
}

test("non-push commands pass through untouched", async () => {
  assert.deepEqual(await decide("Bash", { command: "git status && ls" }), { decision: "none", asked: false });
});

test("push to a feature branch asks the user", async () => {
  assert.deepEqual(await decide("Bash", { command: "git push -u origin feat/x" }), { decision: "allow", asked: true });
  assert.deepEqual(await decide("Bash", { command: "git push origin feat/x" }, "n"), { decision: "deny", asked: true });
});

test("push to main/master is blocked without asking", async () => {
  for (const command of ["git push origin main", "git push origin HEAD:main", "git push -f origin master"]) {
    assert.deepEqual(await decide("Bash", { command }), { decision: "deny", asked: false }, command);
  }
});

test("branch names containing 'main' are not treated as main", async () => {
  assert.equal((await decide("Bash", { command: "git push origin feature-main" })).decision, "allow");
});

test("GitHub MCP writes ask; writes to main are blocked", async () => {
  assert.deepEqual(await decide("mcp__github__create_pull_request", { head: "feat/x", base: "main" }), { decision: "allow", asked: true });
  assert.deepEqual(await decide("mcp__github__push_files", { branch: "main" }), { decision: "deny", asked: false });
  assert.deepEqual(await decide("mcp__github__get_file_contents", { path: "x" }), { decision: "none", asked: false });
});

test("design library: yaml, plain URL lists, and ranked search", () => {
  const dir = mkdtempSync(join(tmpdir(), "dl-"));
  writeFileSync(join(dir, "a.yaml"), "links:\n  - {title: Linear, url: https://linear.app, tags: [dashboard, dark]}\n  - {title: Stripe, url: https://stripe.com, tags: [landing]}\n");
  writeFileSync(join(dir, "b.txt"), "https://a.com\nnot a link\nhttps://b.com\n");
  const links = loadDesignLinks(join(dir, "a.yaml"));
  assert.equal(searchDesignLinks(links, "dark dashboard")[0].title, "Linear");
  assert.equal(loadDesignLinks(join(dir, "b.txt")).length, 2);
});

test("plugin discovery finds nested .claude-plugin dirs", () => {
  const root = mkdtempSync(join(tmpdir(), "pl-"));
  for (const p of ["superpowers", "claude-mem/plugin"]) {
    mkdirSync(join(root, p, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, p, ".claude-plugin", "plugin.json"), "{}");
  }
  const found = discoverPlugins(root).map((p) => p.path.replace(root + "/", "")).sort();
  assert.deepEqual(found, ["claude-mem/plugin", "superpowers"]);
});

test("UI-LINKS.md: parses sections, notes, and hides Swift-only refs for web work", async () => {
  const { filterByPlatform } = await import("../src/tools/design-library.js");
  const links = loadDesignLinks(join(process.cwd(), "design-library", "UI-LINKS.md"));
  assert.equal(links.length, 30);
  const magic = links.find((l) => l.title === "Magic UI")!;
  assert.equal(magic.url, "https://magicui.design/docs/components");
  assert.match(magic.notes ?? "", /animated React\/Tailwind/);
  assert.equal(magic.swiftOnly, false);
  assert.ok(links.find((l) => l.title === "joogps/Glur")!.swiftOnly);
  assert.ok(links.find((l) => l.title.startsWith("Apple Human"))!.swiftOnly);

  const web = filterByPlatform(links, "web");
  assert.equal(web.length, 17);
  assert.ok(!web.some((l) => l.swiftOnly));
  assert.equal(filterByPlatform(links, "web", "swiftui toast").length, 30); // query mentions Swift
  assert.deepEqual(searchDesignLinks(filterByPlatform(links, "swift"), "toasts").slice(0, 2).map((l) => l.title).sort(), ["exyte/PopupView", "omaralbeik/Drops"]);
  assert.ok(searchDesignLinks(web, "smooth scrolling").some((l) => l.title === "Lenis"));
});
