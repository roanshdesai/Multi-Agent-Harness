# Multi-Agent Harness: project context

Hand-off notes for whoever works on this next (a person or an AI coding agent). Read this first, then `README.md`.

## What it is

A personal multi-model agent harness built on the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). It has two front ends on one engine:

- **Desktop app** (Electron): `npm run desktop`; installers via `npm run desktop:mac` / `desktop:win`.
- **Terminal app**: `npm start`. While the desktop app is open, the terminal joins its tabs live.

One orchestrator plans and delegates to specialists on different models.

| Role | Model | Notes |
|---|---|---|
| Orchestrator | `claude-fable-5-2` | Must delegate; only coordinates (prompt in `src/session.ts`) |
| Advisor | `claude-fable-5-2` | Server-side advisor tool (`settings.advisorModel`): the working model consults it on its own. Also an `advisor` subagent as a backstop after 3 tool failures (`src/guards.ts`) |
| Designer | `claude-opus-5-5` | Own role (`models.designer`); falls back to the coder's model if unset |
| Coder, verifier | `claude-fable-5-1` | The verifier checks delegated work on a throwaway fork (`Harness.verify`) |
| Quick coder | `claude-sonnet-5-5` | `quick-coder` agent (`models.quick_coder`): mechanical, well-scoped edits, picked up front by the orchestrator |
| 3D CAD | `claude-fable-5-2` | `cad` agent (`models.cad`): Onshape advice and FeatureScript saved under `./cad/` |
| Researcher, summarizer, GUI-tester coordinator | `claude-sonnet-5-5` | |
| GUI testing | `gpt-6-astra` via Codex CLI | `src/tools/gui-test.ts`; falls back to Playwright MCP |
| Images | `gpt-6.1-sol` via Codex (falls back to `gpt-6-astra`) | `src/tools/gpt.ts` |
| GPT chat tabs | `gpt-6-astra`, `gpt-6.1-sol` | `src/gpt-chat.ts` + `src/codex.ts` |

All models are set in `harness.config.yaml`, and can be changed in the app with `/models` (or Edit models… in the picker), which writes back to the file.

## Hard rules (the owner's preferences)

1. **Subscriptions only.** Claude runs on the Claude Code subscription login; GPT runs on the ChatGPT login through the Codex CLI. API keys are stripped (`src/subscription.ts`), and startup refuses API billing. `HARNESS_ALLOW_API=1` is an explicit opt-out, used only for testing in containers.
2. **Only GitHub pushes, PRs and merges ask for approval** (`src/guards.ts`). Everything else runs without prompts (`permissionMode: bypassPermissions`). Pushes to `main`/`master` are always refused.
3. **Git hosting:** never push to `main` from the `roansh-desai` account. On the `roanshdesai` account the owner has said to push to `main` (it is the branch to use); the work branch is kept in sync with it.
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
src/projects.ts     Projects (projects.yaml in the data folder): groups → projects → sub-projects; bankFor(cwd) picks the Hindsight bank, bankMcpUrl() its single-bank MCP address
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
src/tools/           design_library, gui_test, ask_gpt, image, computer_use (Codex computer/browser use with models.gui; apps allow-listed by bundle id under computer_use)
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

Claude in Chrome (`extensions.claude_in_chrome` passes `--chrome` to Claude Code) · `/computer test | <task>` (GPT computer use through Codex) · `/caffeinate [off|30m|2h|display]` (app: Electron powerSaveBlocker + title-bar chip; terminal: macOS caffeinate -i -w <pid>, systemd-inhibit on Linux) · `/remote` (control the app from Pally or any MCP client; off by default, push approvals stay local) · Live "working…" line under the thread (Thinking / Running <cmd> / <agent> is working / Verifying…, with a timer) · Context hand-off (past `context.handoff_at`, default 80%, a chat writes `.harness/handoffs/<session>/context.md` on a throwaway fork and offers "Continue in a new chat", which seeds a new tab with it; `/handoff` any time; Claude chats only) · Home-screen token usage (All / Claude / ChatGPT tabs: totals, streaks, top model, year calendar grid, book comparison) · Tabs (parallel tasks) · `@app` mentions (type @ in the composer to name a connected MCP server, e.g. @pally, @slack; the model is told to use that server's `mcp__<name>__*` tools and may call them itself) · live terminal link · `/btw` · `/fork` (new window, or a new terminal window from the CLI) · `/change` (⌘Enter) · verifier · automatic advisor · `/subagents` (advisor designs, you approve) · Claude/GPT model picker per tab · image agent · `/usage` + automatic switch to GPT when Claude is out · agent questions (answer in app or terminal) · MCP servers & apps panel (`/connections`, `/mcp`, `/apps`) · Documents pane with PRD summaries (`/docs`, `/summarize`) · `/context` grid · memory viewers (claude-mem, Hindsight) · UI links library · evals · original UI (dark graphite palette with one signal accent, sans + mono type, dense layout, log-style agent timeline, instrument panel) · add MCP servers from the app (URLs go into Claude Code's user list so sign-in works; Sign in opens `claude /mcp` in a terminal) · chats from every folder, opened in their own folder; Cloud sessions link to claude.ai/code.

## How to test

```bash
npm install
npx tsc --noEmit && npm test          # 32 unit tests
HARNESS_ALLOW_API=1 npm start         # only in containers without a subscription
```

- **Desktop end-to-end in a headless container:** `xvfb-run -a node script.cjs`, using Playwright's `_electron.launch({ executablePath: node_modules/electron/dist/electron, args: ["--no-sandbox", "--disable-gpu", "<repo>"] })`.
- **GPT without OpenAI access:** set `HARNESS_CODEX_BIN=test/fixtures/fake-codex.mjs`.
- **Packaged build check:** `npx electron-builder --linux dir`, then launch `release/linux-unpacked/agent-harness`.

## Verified on the owner's Mac (2026-11-09)

- Codex 0.167 signed in with ChatGPT (`npx codex login status`). `gpt-6-astra` and `gpt-6.1-sol` are accepted as-is; GPT tabs run two-turn chats on both and resume the thread.
- ChatGPT usage meter reads the real plan through `codex app-server` (weekly window).
- Token stats from real Codex logs. Codex compresses older rollouts to `.jsonl.zst` (244 of 310 on the Mac); those are now read too (fixed).
- Claude on the subscription login (Claude Team, no API key).
- Hindsight runs **natively, not in Docker**: launch agents `io.vectorize.hindsight-api` (API + MCP on 8888) and `io.vectorize.hindsight-ui` (UI on 9999), installed by Hindsight itself; Docker Desktop isn't installed. Start Hindsight now restarts those launch agents and only falls back to `docker compose` when they're missing (fixed). An agent session reached http://localhost:8888/mcp/ and called `list_banks`.
- Computer use with GPT-6 Astra: `/computer test` and a real task (open Chrome, search "rikin", read the results) work. Findings and fixes:
  - 127.0.0.1:19789 was never the computer-use helper. It's an unrelated Codex MCP server, `palmier-pro` in `~/.codex/config.toml` (PalmierPro.app), and its error shows on every Codex run. The tool blamed it for every result; now a finished task counts, and unreachable ports are named after their MCP server.
  - Computer use itself is ChatGPT.app's `cua_repl` / `node_repl` (`computer-use@openai-bundled`, `unified-computer-use@openai-bundled`). Accessibility and Screen Recording were already granted.
  - App access is decided by the **ChatGPT app's approvals**, not Codex's `computer_use.*` flags: Finder was refused even when listed, Chrome (approved in the ChatGPT app) worked with no flags. `codex exec` can't show the approval prompt, so the tool now tells you to approve the app in the ChatGPT app. It never operates the harness app itself, so `/computer test` tries Finder, Chrome, then Safari.
  - The per-app `-c computer_use.macos.bundle_ids."com.x"=…` form made Codex exit; it's now one inline table.
- Claude in Chrome: `claude-in-chrome` connects (20 tools) and the extension answers (`tabs_context_mcp`).
- Pally: in Claude Code's user MCP list, connected and signed in; `@pally …` through the harness CLI got Pally's reply.
- `/remote` over a real cloudflared quick tunnel (cloudflared 2026.10.5 installed): `initialize`, `tools/list`, `list_tabs` work from the public link; a wrong token gets 404.

## Not verified yet

- Real image generation (Codex `image_generation` feature).
- Actually hitting the Claude usage limit; the switch to GPT is tested with a simulated limit.
- The Windows installer.
- Pally actually using `/remote`. Pally connects to a custom MCP URL when you paste it in a Pally chat, but asked not to be given a URL with a reusable secret in the path (which is how `/remote` links work) and prefers a plain endpoint with separate bearer auth. Quick-tunnel URLs also change on every start. Open decision: add bearer-token auth (and/or a named, stable Cloudflare tunnel) to `/remote`.
- Listing cloud (claude.ai/code) sessions inside the app: the SDK has no API for it, so the Chats pane links out.
- `/computer` from inside the running app (verified through the same code path from the terminal; the app open on the Mac was an older build).

## Fixed after the Mac check (2026-11-09)

- The packaged app showed no Hindsight dot and agents had no Hindsight address: `~/.agent-harness/harness.config.yaml` was an early copy without `memory:` (or `computer_use:`, `extensions:`, `remote:`). The packaged app now fills missing settings from its bundled config (`loadConfig(root, defaultsFile)`, `withDefaults`); the user's values and lists win, and the file isn't rewritten. The owner confirmed Hindsight opens in the app.
- Opening the app while a copy ran without a window (macOS keeps it alive) quit the new copy and showed nothing. The running copy now opens a window on `second-instance`.

## Projects and per-project memory (2026-11-09)

- Sidebar Projects tab (default pane): groups → projects → sub-projects, stored in `projects.yaml` in the data folder (gitignored in the repo, since it holds personal paths). The owner's list is set up on the Mac.
- Each Harness connects to `memory.hindsight_mcp` + `<bank>/` for its folder: single-bank mode, no `list_banks`, `recall` has no `bank_id`. Verified with an MCP client.
- Default bank = what the Hindsight coding-agent plugin uses (`coding-agent::<repo>`, worktrees → main repo, its `mapPathToBank` first). Worktrees that should have their own memory get a `mapPathToBank` entry in `~/.hindsight/coding-agent.json` and `bank:` in projects.yaml, so Claude Code and the harness agree.
- Seeding a repo into Hindsight: `node ~/.hindsight/coding-agents/dist/hindsight-seed.js seed --repo <dir>`. Hindsight's LLM on the Mac is `claude-code` (subscription). Renaming a bank id in place: `hindsight-admin rename-bank --from <id> --to <id>`.
- Memory probe fix: the sidebar showed Hindsight as stopped while it was busy, because the check followed the UI's redirect to a slow dashboard with a 1.2s limit. It no longer follows redirects and waits 3s.

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

- GitHub: `roanshdesai/Multi-Agent-Harness` (renamed from `roanshdesai/test`; GitHub redirects the old URL).
- `main` has everything. `claude/agent-harness-model-routing-wun9p7` (draft PR #1) is kept identical to it.
- GitHub's default branch is still the work branch: switch it to `main` under Settings → General → Default branch.
- On the owner's Mac the clone is a folder named `agent-harness`; the app's data folder is `~/.agent-harness` (logs in `~/.agent-harness/out/`, settings state in `~/.agent-harness/.harness/`).
- Update on the Mac: quit the app, then `git pull origin main`, `npm install`, `npm run desktop`.

## Where things stand (hand-off)

Items 1–6 of the Mac check were worked through on 2026-11-09 (see "Verified on the owner's Mac"). What's left:

1. **Packaging:** `npm run desktop:mac` builds on the Mac (2026-11-09: ~409 MB arm64 .dmg, signed with the owner's Apple Development certificate, `codesign --verify --deep --strict` passes, the .dmg mounts). Signing takes ~15 minutes (it timestamps every file). Notarization is skipped (no notarize settings), so other Macs will warn on first open. The built app launches, stays up and opens its bridge socket. `desktop:mac` then deletes `release/mac-arm64` (scripts/drop-unpacked.mjs) so Spotlight only finds the copy in Applications; install from the .dmg. Quit any running copy before launching a new build, since the single-instance lock makes a second launch just focus the old one.
2. **Pally + /remote:** decide on bearer auth / a stable tunnel (see "Not verified yet"), then add the link in Pally.
3. **Computer use:** approve any other apps you want GPT to use in the ChatGPT app (Finder isn't approved yet).
4. Optional clean-up outside this repo: `palmier-pro` in `~/.codex/config.toml` fails on every Codex run (turn it off if PalmierPro isn't used), and the `cardboard` skill's SKILL.md has invalid YAML for Codex.
