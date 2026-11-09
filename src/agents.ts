import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessConfig } from "./config.js";
import { loadSubagents, toAgentDefinition } from "./subagents.js";

/**
 * Subagents the main orchestrator can delegate to via the Agent tool.
 * Each one runs on its own model.
 */
/** Agents whose real work runs on a model other than their own (shown in /agents and the app). */
export function agentRunsOn(cfg: HarnessConfig): Record<string, string> {
  const out: Record<string, string> = {
    "gui-tester": `${cfg.models.gui} (via Codex, ChatGPT plan)`,
    image: `${cfg.models.image} (via Codex, ChatGPT plan)`,
  };
  for (const a of loadSubagents(cfg)) if (a.engine === "gpt") out[a.name] = `${a.model} (via Codex, ChatGPT plan)`;
  return out;
}

/** Names of the agents you made with /subagents. */
export function customAgentNames(cfg: HarnessConfig): string[] {
  return loadSubagents(cfg).map((a) => a.name);
}

/** Built-in team plus your /subagents (yours win on a name clash). */
export function buildAgents(cfg: HarnessConfig): Record<string, AgentDefinition> {
  const team = builtinAgents(cfg);
  for (const a of loadSubagents(cfg)) team[a.name] = toAgentDefinition(a, cfg);
  return team;
}

function builtinAgents(cfg: HarnessConfig): Record<string, AgentDefinition> {
  const m = cfg.models;
  return {
    advisor: {
      description:
        "Senior advisor. Use when stuck, after repeated failures, when choosing between approaches, or before any irreversible decision. Give it the goal, what was tried, and the exact errors.",
      model: m.advisor,
      effort: cfg.effort.advisor,
      tools: ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
      prompt: `You are the advisor. Another agent is stuck or facing a hard call.
Diagnose the root cause from the evidence given, then reply with:
1. What is actually going wrong (one paragraph).
2. The single approach you recommend, as concrete steps.
3. What would prove the approach worked.
Read files yourself if needed. Do not edit anything.`,
    },

    coder: {
      description:
        "Writes, edits, refactors and debugs code. Use for ANY coding work: features, bug fixes, tests, scripts. Follows the superpowers workflow (plan, TDD, verify).",
      model: m.coder,
      effort: cfg.effort.coder,
      prompt: `You are the coding agent. Work test-first where the project has tests.
Use the superpowers skills (brainstorming, writing-plans, test-driven-development, systematic-debugging, verification-before-completion) and gstack skills (/review, /qa) when they fit.
Before UI work, call the design_library tool (platform "swift" for SwiftUI/iOS, otherwise "web") and build with the libraries it returns, e.g. Magic UI, SmoothUI, Unlumen, 21st.dev components and Lenis for scrolling. Swift-only references (Apple HIG, Pow, Glur, PopupView...) are for Swift projects only.
Run the project's checks before saying you are done, and report the exact commands and results.
Never push to git; the main agent handles pushes.`,
    },

    researcher: {
      description:
        "Research, web search, scraping, data gathering, and general non-coding tasks. Use for anything that is mostly reading.",
      model: m.worker,
      effort: cfg.effort.worker,
      prompt: `You are a research worker. Use Firecrawl/Exa/WebSearch/WebFetch and Context7 for library docs.
Return findings as a concise brief with a source URL on every claim. Flag anything you could not verify.
Save large raw dumps to files under .harness/scratch/ and return the path rather than pasting them.`,
    },

    summarizer: {
      description:
        "Compresses long scraped pages, logs or transcripts into tight notes before they reach the main agent.",
      model: m.triage,
      effort: "low",
      tools: ["Read", "Write", "Glob", "Grep"],
      prompt: `Compress the input into the facts that matter for the stated goal. Keep numbers, names, URLs and quotes exact. Drop everything else.`,
    },

    "gui-tester": {
      description:
        "Tests web UIs in a real browser. The testing itself runs on GPT through Codex (gui_test tool); this agent briefs it and falls back to Playwright MCP if Codex fails.",
      model: m.worker,
      effort: cfg.effort.worker,
      prompt: `You test user interfaces.
1. First call the gui_test tool with the URL and a precise checklist of what to verify.
2. If gui_test errors or is unavailable, do the same checks yourself with the Playwright MCP tools (mcp__playwright__*).
Report each check as PASS/FAIL with evidence (screenshot path, console errors, observed text).`,
    },

    image: {
      description: `Any image work: generating images, icons, illustrations and mockups, editing images, or reviewing screenshots. The image work runs on ${m.image} through Codex (image tool); this agent briefs it.`,
      model: m.worker,
      effort: "low",
      tools: ["Read", "Glob", "mcp__harness__image", "mcp__harness__design_library"],
      prompt: `You handle images. Use the mcp__harness__image tool for all of it: task "generate" for new images, "edit" with input paths to change one, "analyze" to describe or review screenshots.
Write precise prompts: subject, composition, style, colors, text in the image, aspect ratio. For UI mockups, call design_library first and describe the references' style.
Return the saved file paths and one line on each.`,
    },

    video: {
      description: "Video work: editing, cutting, captions, rendering, analysis of video files.",
      model: m.video,
      effort: cfg.effort.main,
      prompt: `You handle video. Use ffmpeg/ffprobe via Bash for cutting, encoding, captions and frame extraction; use Remotion when asked to generate video from code.
Inspect frames you extract to verify results. Write outputs to ./out/ and report the paths.`,
    },

    designer: {
      description: "UI/UX design and frontend look-and-feel. Always grounded in the user's design links library.",
      model: m.designer ?? m.coder,
      effort: cfg.effort.coder,
      prompt: `You design interfaces, grounded in the user's UI links library.
1. Call design_library first. Use platform "swift" only for SwiftUI/iOS work; for web, Swift-only references (Apple HIG and the SwiftUI repos) are off-limits.
2. Prefer real components from the library (Magic UI, SmoothUI, Unlumen UI, 21st.dev, Libraries.dev) over hand-rolled ones; use Lenis for smooth scrolling and Design Spells for micro-interaction ideas.
3. For a brand look, pull the matching DESIGN.md from voltagent/awesome-design-md.
4. Use the taste-skill skills (taste, minimalist, redesign, soft) when they are installed.
5. Open the references you pick (WebFetch or Playwright) and say which ones you followed. Mobbin needs a login, so only cite it.`,
    },

    verifier: {
      description:
        "Checks a worker's output against the original task before it is accepted. Use after every subagent result that will be shown to the user or committed.",
      model: m.verifier,
      effort: cfg.effort.verifier,
      tools: ["Read", "Grep", "Glob", "Bash", "WebFetch"],
      prompt: `You are the verifier. Given a task and a result, check the result independently (re-run tests, open files, re-check sources).
Reply with exactly one first line: VERDICT: PASS or VERDICT: FAIL, followed by the specific problems and how to fix them.`,
    },
  };
}
