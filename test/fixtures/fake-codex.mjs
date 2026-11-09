#!/usr/bin/env node
// Stands in for the Codex CLI in tests: answers `login status` and emits `exec --json` events.
const args = process.argv.slice(2);
if (args[0] === "login" && args[1] === "status") {
  console.log("Logged in using ChatGPT");
  process.exit(0);
}
const resumeIdx = args.indexOf("resume");
const thread = resumeIdx >= 0 ? args[args.length - 2] : "thread-123";
const prompt = args[args.length - 1];
const emit = (o) => console.log(JSON.stringify(o));
if (resumeIdx < 0) emit({ type: "thread.started", thread_id: thread });
emit({ type: "turn.started" });
emit({ type: "item.started", item: { id: "i1", type: "command_execution", command: "ls -la", status: "in_progress" } });
emit({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls -la", status: "completed" } });
emit({ type: "item.completed", item: { id: "i2", type: "agent_message", text: `echo(${args.includes("-m") ? args[args.indexOf("-m") + 1] : "?"}): ${prompt}` } });
emit({ type: "turn.completed", usage: {} });
