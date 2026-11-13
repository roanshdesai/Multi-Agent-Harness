#!/usr/bin/env node
// Stands in for `claude --cloud "<task>"` in tests.
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + "\n");
// FAKE_CLAUDE_503=<file>: fail once with a 503 (like the real service sometimes does), then work.
if (process.env.FAKE_CLAUDE_503 && !existsSync(process.env.FAKE_CLAUDE_503)) {
  writeFileSync(process.env.FAKE_CLAUDE_503, "1");
  console.error("Error: Cloud session create failed: Request failed with status code 503");
  process.exit(1);
}
// Same shape as Claude Code 2.1.323's output.
console.log("Created cloud session: Finish the feature\nView: https://claude.ai/code/session_test123?from=cli&m=0\nResume with: claude --teleport session_test123");
