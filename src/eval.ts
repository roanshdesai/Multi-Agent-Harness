import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { Harness } from "./session.js";

interface EvalTask {
  name: string;
  prompt: string;
  /** Subagent the orchestrator is expected to route to. */
  expect_agent?: string;
  contains?: string[];
  regex?: string[];
  /** Plain-language rubric graded by the verifier model. */
  judge?: string;
  max_turns?: number;
}

/**
 * Re-runnable eval suite (item 6). Each task runs headless on a fresh,
 * unsaved session; checks are routing, string/regex, and an LLM judge.
 */
export async function runEvals(harness: Harness, filter = "", log: (line: string) => void = console.log) {
  const dir = join(harness.cfg.root, "evals", "tasks");
  if (!existsSync(dir)) return log("No evals/tasks directory.");
  const tasks: EvalTask[] = readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => YAML.parse(readFileSync(join(dir, f), "utf8")))
    .filter((t: EvalTask) => !filter || t.name.includes(filter));

  const results = [];
  for (const t of tasks) {
    const started = Date.now();
    const r = await harness.run(t.prompt, { persistSession: false, maxTurns: t.max_turns ?? 40 });
    const failures: string[] = [];
    if (r.isError) failures.push(`run error: ${r.text}`);
    if (t.expect_agent && !r.agentsUsed.includes(t.expect_agent))
      failures.push(`expected agent "${t.expect_agent}", used [${r.agentsUsed.join(", ")}]`);
    for (const s of t.contains ?? []) if (!r.text.toLowerCase().includes(s.toLowerCase())) failures.push(`missing "${s}"`);
    for (const re of t.regex ?? []) if (!new RegExp(re, "i").test(r.text)) failures.push(`no match /${re}/`);
    if (t.judge) {
      const j = await harness.run(
        `Grade this answer against the rubric. Reply with first line "GRADE: PASS" or "GRADE: FAIL" then one sentence why.\n\nTASK:\n${t.prompt}\n\nRUBRIC:\n${t.judge}\n\nANSWER:\n${r.text}`,
        { persistSession: false, model: harness.cfg.models.verifier, maxTurns: 1, tools: [], agents: {}, mcpServers: {} },
      );
      if (!/GRADE:\s*PASS/i.test(j.text)) failures.push(`judge: ${j.text.split("\n").slice(0, 2).join(" ")}`);
    }
    const passed = failures.length === 0;
    log(`${passed ? "PASS" : "FAIL"}  ${t.name}${passed ? "" : `\n   ${failures.join("\n   ")}`}`);
    results.push({ ...t, passed, failures, agentsUsed: r.agentsUsed, costUsd: r.costUsd, ms: Date.now() - started });
  }

  const outDir = join(harness.cfg.root, "evals", "results");
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify({ models: harness.cfg.models, results }, null, 2));
  const passed = results.filter((r) => r.passed).length;
  log(`${passed}/${results.length} passed · saved ${file}`);
}
