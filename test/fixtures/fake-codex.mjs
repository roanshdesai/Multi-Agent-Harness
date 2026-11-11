#!/usr/bin/env node
// Stands in for the Codex CLI in tests: answers `login status` and emits `exec --json` events.
const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_LOG) (await import("node:fs")).appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(args) + "\n");
if (args[0] === "login" && args[1] === "status") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
if (args[0] === "app-server") {
  // Minimal app-server: initialize, then account/rateLimits/read with fixed numbers.
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      if (msg.method === "initialize") console.log(JSON.stringify({ id: msg.id, result: { userAgent: "fake" } }));
      if (msg.method === "account/rateLimits/read") {
        const now = Math.floor(Date.now() / 1000);
        console.log(JSON.stringify({ id: msg.id, result: { rateLimits: { planType: "plus", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: now + 3600 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: now + 86400 } } } }));
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
} else {
const resumeIdx = args.indexOf("resume");
const thread = resumeIdx >= 0 ? args[args.length - 2] : "thread-123";
const prompt = args[args.length - 1];
const emit = (o) => console.log(JSON.stringify(o));
if (resumeIdx < 0) emit({ type: "thread.started", thread_id: thread });
emit({ type: "turn.started" });
if (prompt.includes("spawn")) {
  emit({ type: "item.started", item: { id: "c1", type: "collab_tool_call", tool: "spawn_agent", prompt: "check the tests", status: "in_progress" } });
  emit({ type: "item.completed", item: { id: "c2", type: "collab_tool_call", tool: "wait", agents_states: { a1: { status: "completed", message: "tests pass" } }, status: "completed" } });
}
if (prompt.includes("slow")) await new Promise((r) => setTimeout(r, 5000)); // long enough to be interrupted
emit({ type: "item.started", item: { id: "i1", type: "command_execution", command: "ls -la", status: "in_progress" } });
emit({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls -la", status: "completed" } });
emit({ type: "item.completed", item: { id: "i2", type: "agent_message", text: `echo(${args.includes("-m") ? args[args.indexOf("-m") + 1] : "?"}): ${prompt}` } });
emit({ type: "turn.completed", usage: { input_tokens: 27200, cached_input_tokens: 20000, output_tokens: 50 } });
// -o <file>: Codex writes the final message there.
const oi = args.indexOf("-o");
if (oi >= 0) (await import("node:fs")).writeFileSync(args[oi + 1], `echo(${args.includes("-m") ? args[args.indexOf("-m") + 1] : "?"}): ${prompt}`);
}
