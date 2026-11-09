# Multi-Agent Harness: project context

Hand-off notes for whoever works on this next (a person or an AI coding agent). Read this first, then `README.md`.

## What it is

A personal multi-model agent harness built on the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). It has two front ends on one engine:

- **Desktop app** (Electron): `npm run desktop`; installers via `npm run desktop:mac` / `desktop:win`.
- **Terminal app**: `npm start`. While the desktop app is open, the terminal joins its tabs live.

One orchestrator plans and delegates to specialists on different models.

| Role | Model | Notes |
|---|---|---|
| Orchestrator | `claude-opus-5-5` | Must delegate; doesn't do the work itself (prompt in `src/session.ts`) |
| Advisor | `claude-fable-5-1` | Server-side advisor tool (`settings.advisorModel`): the working model consults it on its own. Also an `advisor` subagent as a backstop after 3 tool failures (`src/guards.ts`) |
| Designer | `claude-opus-5-5` | Own role (`models.designer`); falls back to the coder's model if unset |
| Coder, verifier | `claude-fable-5-1` | The verifier checks delegated work on a throwaway fork (`Harness.verify`) |
| Researcher, summarizer, GUI-tester coordinator | `claude-sonnet-5-5` | |
| GUI testing | `gpt-6-astra` via Codex CLI | `src/tools/gui-test.ts`; falls back to Playwright MCP |
| Images | `gpt-6.1-sol` via Codex (falls back to `gpt-6-astra`) | `src/tools/gpt.ts` |
| GPT chat tabs | `gpt-6-astra`, `gpt-6.1-sol` | `src/gpt-chat.ts` + `src/codex.ts` |

All models are set in `harness.config.yaml`, and can be changed in the app with `/models` (or Edit models… in the picker), which writes back to the file.

## Hard rules (the owner's preferences)

1. **Subscriptions only.** Claude runs on the Claude Code subscription login; GPT runs on the ChatGPT login through the Codex CLI. API keys are stripped (`src/subscription.ts`), and startup refuses API billing. `HARNESS_ALLOW_API=1` is an explicit opt-out, used only for testing in containers.
2. **Only GitHub pushes, PRs and merges ask for approval** (`src/guards.ts`). Everything else runs without prompts (`permissionMode: bypassPermissions`). Pushes to `main`/`master` are always refused.
3. **Git hosting:** never push to `main` unless the owner explicitly says so for that account. Work on feature branches and open draft PRs.
4. **Never commit `.env`, tokens or personal info.** `.env`, `.harness/`, `vendor/`, `out/`, `release/` and `mcp-servers.json` are gitignored.
5. **Design:** the UI must look original, not copied from VS Code or GitHub and not "vibe-coded" (no gradients, glows, glass or emoji). References are allowed; the owner's UI links library is `design-library/UI-LINKS.md`.

## Architecture (where things live)

```
src/session.ts       Harness: SDK options (models, agents, MCP, plugins, hooks, sandbox, advisor,
                     canUseTool for AskUserQuestion), run() with streaming input (steering for
                     /change), context usage, verify(), connections(), designSubagents()
src/engine.ts        ChatEngine (one Claude chat): turns, queue, verifier loop, /btw, /fork,
                     /change, questions, history (hides internal notices); the Engine interface
src/gpt-chat.ts      GptChat: the same Engine interface over Codex; transcripts in .harness/gpt-chats
src/codex.ts         runCodex(): `codex exec --json`, parses thread/item/turn events
src/remote.ts        /remote: MCP server (Streamable HTTP, JSON replies) on 127.0.0.1:remote.port, secret in the URL, optional cloudflared quick tunnel; tools list_tabs/send_message/get_reply/read_chat/answer_question/stop/usage
src/memory.ts        Start claude-mem (`npx claude-mem start`, doctor) and Hindsight (`docker compose up -d hindsight`) from the app; claude-mem port from ~/.claude-mem/settings.json
src/token-stats.ts   Token usage over time for the home screen: Claude Code + Codex transcripts, cached per file
src/codex-usage.ts   ChatGPT plan usage: `codex app-server`, initialize, then account/rateLimits/read
src/host.ts          Host: open tabs (each with its own engine), usage-limit fallback to GPT,
                     files touched by agents
src/bridge.ts        Unix socket ~/.agent-harness/bridge.sock (named pipe on Windows), NDJSON;
                     the desktop app hosts it and the terminal attaches
src/desktop/main.ts  Electron main process: windows, IPC, memory-viewer header stripping,
                     packaged-binary lookup
desktop/renderer/    index.html, styles.css, app.js (vanilla JS, no framework), preload.cjs
src/cli.ts           Terminal app (standalone, or linked to the app)
src/commands.ts      One slash-command list for both apps, merged with skill/plugin commands
src/agents.ts        Built-in subagents + agentRunsOn; merges custom ones from subagents.yaml
src/subagents.ts     /subagents storage; prompt for the advisor to design subagents
src/connections.ts   MCP servers & apps: live status, add (mcp-servers.json), turn off
src/usage.ts         Claude plan usage windows (5-hour/weekly) from rate_limit_event; exhaustion rule
src/docs.ts          Documents pane: listing, PRD detection, summaries (cached in .harness)
src/tools/           design_library, gui_test, ask_gpt, image
src/guards.ts        Push approval hook, stuck detector
src/mcp.ts           Harness MCP servers (GitHub, Slack, Outlook, Hindsight, Firecrawl, Exa, Context7, Playwright)
src/eval.ts, evals/  Eval runner and tasks
test/core.test.ts    Unit tests (node:test); test/fixtures/fake-codex.mjs stands in for Codex
```

Key SDK facts this project relies on (Agent SDK v0.3.x):
- `query({ prompt: AsyncIterable })` plus pushing a user message with `priority: "next"` lets a running task take a correction without stopping (`/change`).
- `q.getContextUsage()` returns `gridRows`, the same squares Claude Code's `/context` draws.
- `rate_limit_event` carries `unifiedWindows` (five_hour/seven_day utilization). Plan usage is also read on demand with `q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` (guarded: if it disappears, usage comes only from messages).
- `q.supportedModels()` lists the Claude models the plan offers; the model pickers use it, so no model list is hardcoded.
- `canUseTool` still fires for `AskUserQuestion` under `bypassPermissions`. The SDK prints a "shadowed" warning, which is suppressed in `session.ts`.
- `q.mcpServerStatus()`, `toggleMcpServer()`, `reconnectMcpServer()` are used for the connections panel.
- `settings: { advisorModel }` enables the server-side advisor tool.

## Features (all shipped)

`/caffeinate [off|30m|2h|display]` (app: Electron powerSaveBlocker + title-bar chip; terminal: macOS caffeinate -i -w <pid>, systemd-inhibit on Linux) · `/remote` (control the app from Pally or any MCP client; off by default, push approvals stay local) · Live "working…" line under the thread (Thinking / Running <cmd> / <agent> is working / Verifying…, with a timer) · Context hand-off (past `context.handoff_at`, default 80%, a chat writes `.harness/handoffs/<session>/context.md` on a throwaway fork and offers "Continue in a new chat", which seeds a new tab with it; `/handoff` any time; Claude chats only) · Home-screen token usage (All / Claude / ChatGPT tabs: totals, streaks, top model, year calendar grid, book comparison) · Tabs (parallel tasks) · `@app` mentions (type @ in the composer to name a connected MCP server, e.g. @pally, @slack; the model is told to use that server's `mcp__<name>__*` tools and may call them itself) · live terminal link · `/btw` · `/fork` (new window, or a new terminal window from the CLI) · `/change` (⌘Enter) · verifier · automatic advisor · `/subagents` (advisor designs, you approve) · Claude/GPT model picker per tab · image agent · `/usage` + automatic switch to GPT when Claude is out · agent questions (answer in app or terminal) · MCP servers & apps panel (`/connections`, `/mcp`, `/apps`) · Documents pane with PRD summaries (`/docs`, `/summarize`) · `/context` grid · memory viewers (claude-mem, Hindsight) · UI links library · evals · original UI (dark graphite palette with one signal accent, sans + mono type, dense layout, log-style agent timeline, instrument panel) · add MCP servers from the app (URLs go into Claude Code's user list so sign-in works; Sign in opens `claude /mcp` in a terminal) · chats from every folder, opened in their own folder; Cloud sessions link to claude.ai/code.

## How to test

```bash
npm install
npx tsc --noEmit && npm test          # 30 unit tests
HARNESS_ALLOW_API=1 npm start         # only in containers without a subscription
```

- **Desktop end-to-end in a headless container:** `xvfb-run -a node script.cjs`, using Playwright's `_electron.launch({ executablePath: node_modules/electron/dist/electron, args: ["--no-sandbox", "--disable-gpu", "<repo>"] })`.
- **GPT without OpenAI access:** set `HARNESS_CODEX_BIN=test/fixtures/fake-codex.mjs`.
- **Packaged build check:** `npx electron-builder --linux dir`, then launch `release/linux-unpacked/agent-harness`.

## Not verified yet (needs the owner's Mac)

- Token stats from real Codex session logs (`~/.codex/sessions`); the format was taken from Codex's rollout files and only tested with a sample.
- ChatGPT usage from a real ChatGPT login (`account/rateLimits/read`, Codex 0.167 app server). Tested only with the fake Codex.
- Real GPT runs through Codex. The test container can't reach OpenAI. Check that `gpt-6-astra` and `gpt-6.1-sol` are the names Codex accepts; if not, change them in `harness.config.yaml`.
- Real image generation (Codex `image_generation` feature).
- Running on a Claude subscription login. Containers had API billing, so `HARNESS_ALLOW_API=1` was used.
- Actually hitting the Claude usage limit; the switch to GPT is tested with a simulated limit.
- The Mac `.dmg` and Windows installer. A Linux packaged build was tested.
- Pally sign-in through the app's Sign in button (`claude /mcp`). The container can't reach agent.pally.com.
- Listing cloud (claude.ai/code) sessions inside the app: the SDK has no API for it, so the Chats pane links out.
- /remote from Pally: depends on Pally accepting a custom MCP server URL (pally.com wasn't reachable from the container) and on cloudflared being installed for the public link.
- Starting claude-mem with `npx claude-mem start` (the command is from its README; its docs site wasn't reachable from the container) and Hindsight via Docker on a Mac.
- The Hindsight web UI port. 9999 is assumed; claude-mem is checked on 37701, then 37777.

## Open bugs

None known.

Fixed in the last review:
- Claude usage showed 0 / nothing until the first message: it's now read from the plan at start, when Usage opens, and every `limits.refresh_minutes`
- leftover hardcoded defaults (image model, memory ports) removed from `src/config.ts`
- the Claude meter drew a full bar before any usage data (read as "out of usage"); it now starts empty
- adding an MCP server from the app: re-adding a turned-off server stays off, errors were hidden, and there was no way to sign in from the app
- "Claude usage is over" shown when it wasn't: a stale saved "rejected" snapshot (no reset time), or an extra-usage / single-model refusal, counted as out. Now it needs a future reset and a blocked plan window, and a successful reply clears it
- hardcoded model names and memory ports in the UI text now come from the config
- the start screen redraws after a folder change
- changing the workspace with tabs open: each tab's Harness has a fixed `cwd`; `Host.setWorkspace` moves idle tabs (new Harness + engine, GPT included) and leaves busy tabs in their folder
- two prompts at once in the terminal: a FIFO of pending asks; an answer from the app cancels only that question's prompt
- race while switching to GPT: the engine is swapped before awaiting history, and messages sent meanwhile wait and go to GPT after the hand-off
- push-guard bypasses (chained or multi-line commands, `git -c`, HEAD/@, `--all`/`--mirror`, `gh pr merge`/`create`, `gh api` writes)
- `-p` exiting before the GPT fallback ran
- Stop being unreliable and blocking a tab from closing
- false GPT switches from stale usage data or after Stop
- UTF-8 text split across chunks (bridge, Codex)
- bridge crash or takeover on a second app instance (single-instance lock)
- a linked terminal hanging when the app quits
- `/context` showing the previous chat after `/new`
- `safePath` following symlinks and allowing non-document files

## Known quirks

- When a `/change` arrives while a Bash command is running, Claude Code moves that command to the background. Once, the model misread this as "declined" and stopped early; it didn't happen again.
- The internal data folder is still `~/.agent-harness` (kept through the rename so existing setups keep working).

## Repo & branch

- Work branch: `claude/agent-harness-model-routing-wun9p7`; draft PR #1 into `main`.
- `main` holds only an empty starting commit.
- The repo is still named `test` on GitHub. Rename it to `multi-agent-harness` under Settings, then General.
