#!/usr/bin/env node
// Stands in for `claude -p --output-format json --cloud "<task>"` in tests.
import { appendFileSync } from "node:fs";
if (process.env.FAKE_CLAUDE_LOG) appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + "\n");
console.log(JSON.stringify({ ok: true, session_id: "session_test123", url: "https://claude.ai/code/session_test123" }));
