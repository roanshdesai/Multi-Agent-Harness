# Multi-Agent Harness

A desktop app (Mac, Windows, Linux) and terminal app built on the Claude Agent SDK. You chat with one orchestrator, which hands work to specialists on different models.

| Role | Model | Used for |
|---|---|---|
| Orchestrator | Claude Opus 5.5 | Plans, delegates and combines the results. It doesn't do the work itself. |
| Advisor | Claude Fable 5.1 | Consulted automatically, like in Claude Code: the working model asks it whenever it hits something hard. Also the backstop after 3 tool failures in a row, and `/advisor` asks it directly. |
| Coder | Claude Fable 5.1 | All coding work |
| Designer | Claude Opus 5.5 | UI and visual design |
| Researcher | Claude Sonnet 5.5 | Scraping, research and general tasks |
| Summarizer | Claude Sonnet 5.5 | Shortens long pages and logs before the orchestrator reads them |
| GUI tester | GPT-6 Astra via Codex CLI | Browser testing. Codex drives Playwright on your ChatGPT plan. Falls back to Claude + Playwright MCP if Codex fails or isn't signed in. |
| Images | GPT-6.1 Sol via Codex (falls back to GPT-6 Astra) | Generate, edit, and review screenshots |
| Video | Claude Opus 5.5 | ffmpeg and Remotion |
| Verifier | Claude Fable 5.1 | Checks every delegated result before you see it, on a throwaway copy of the chat |

If Opus is overloaded or unavailable, the orchestrator falls back to `claude-opus-5-5`, then `claude-sonnet-5-5` (set in `models.fallback`).

## Billing: subscriptions only

There are no model API keys. Claude runs on your Claude plan, and GPT-6 Astra runs on your ChatGPT plan through the Codex CLI.

- **Claude:** sign in once in Claude Code (`claude`, then `/login`, then pick your Pro/Max account). The harness uses the same login.
- **GPT-6 Astra:** run `npx codex login` once and choose **Sign in with ChatGPT**.
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and the other API credentials are stripped before anything starts.
- At startup the harness checks your Claude login. If it's an API key, a Console key, or a cloud provider, it refuses to run. `/status` shows both plans.
- To run on API billing anyway (for example in CI), set `HARNESS_ALLOW_API=1`.

**Memory:** Hindsight (MCP) and claude-mem (plugin). **Skills:** Superpowers (plugin) and gstack (`~/.claude/skills`). **Integrations:** GitHub, Slack, Outlook, Firecrawl, Exa, Context7 and Playwright. **Design:** the `design_library` tool searches your UI links file, `design-library/UI-LINKS.md`. Keep adding links under the right `##` heading. Sections marked *(only use if building with swift)* are hidden unless the work is SwiftUI/iOS. Your `taste-skill` skills are installed by `npm run setup`.

## Setup

```bash
npm install
npm run setup             # installs superpowers, claude-mem, gstack, taste-skill, Chromium; signs in to Codex
cp .env.example .env      # integration tokens only (GitHub, Slack, ...), no model keys
docker compose up -d hindsight
npm start
```

Each MCP server is only loaded once its keys are in `.env`. `/status` shows which servers are missing keys.

## Desktop app

Its own look, built to read like a document and an instrument:
- **Type:** a sans-serif for prose and monospace for anything that is data: models, counts, paths, labels.
- **Colour:** dark graphite with one cool signal accent for focus and primary actions. Each model family gets one quiet mark: clay for Claude, moss for GPT, plum for the advisor. Dense spacing, hairline rules, no gradients, glows or glass.
- **Agent work:** shown as a timeline on a thin line, not as boxes.
- **Sidebar:** the workspace, then text-label sections (Chats · Docs · Memory · Apps · Team), with an instrument panel at the bottom showing the context grid, Claude usage and ChatGPT.
- **References:** GitHub, VS Code and Vercel informed how it works, not how it looks.
- **From the UI links library, used sparingly:** a progressive blur under the header (Glur, done for the web), numbers that tick when they change and steps that ease in (Magic UI), and small press and hover details (Design Spells).

**/change:** while a task runs, type a correction and press ⌘Enter, click **Change now**, or use `/change <what to do differently>`. The agent adjusts at its next step without stopping, so you don't need Esc. Enter still queues a message for after the current turn. In a linked terminal, `/change` does the same.

**Context grid:** the status bar shows how much of the context window the chat uses as a small grid. `/context` opens the full square grid Claude Code shows, broken down by category: system prompt, tools, skills, messages, free space.

**Documents:** the Documents pane lists the project's documents (.md, .txt, .pdf, .docx…), with the files the agents opened or edited this session first and PRDs grouped together. Opening one shows it in a tab. **Summarize** (or **Summarize PRD**) gives the main points: a TL;DR, key points, requirements, and open questions. It runs on Sonnet and is cached until the file changes. `/docs` and `/summarize <file>` do the same in the terminal.

**Tabs:** every tab is its own task with its own model, so several run at once (⌘T new tab, ⌘W close, ⌘1–9 switch). A tab that's working shows a moving border.

**Claude or GPT per tab:** the model picker at the top lists the Claude models your plan offers and the GPT models from your settings (ChatGPT plan, through Codex). Change any role's model, or what the picker offers, with `/models` or "Edit models…" at the bottom of the picker. Switching a tab that already has a conversation to the other family opens a new tab, since they can't share history.

**Terminal link:** while the app is open, `npm start` in a terminal joins the same tabs. Messages typed in either show in both; the app marks terminal messages "from terminal". `/tabs`, `/tab <n>` and `/detach` work in the linked terminal. If the app closes, the terminal carries on by itself.

**Memory in the sidebar:** claude-mem and Hindsight open as tabs showing their own viewers, so you can browse and organize what they've stored. A green dot means it's running; otherwise the tab shows how to start it. Addresses are under `memory:` in `harness.config.yaml`.

**MCP servers & apps:** the sidebar's Connections item (or `/connections`, `/mcp`, `/apps`) lists every server the agents can use: the harness's own, ones from your Claude Code setup, plugin servers and claude.ai connectors. It also shows your Claude and ChatGPT accounts and the memory apps. Each server shows its status and tool count. You can reconnect a failed server, turn one off, or add your own by URL or command (saved in `mcp-servers.json`). If a server needs sign-in, open Claude Code (`claude`), run `/mcp` and sign in there.

**Usage:** the bottom of the sidebar shows your Claude plan's 5-hour and weekly usage; `/usage` shows the details and reset times. If Claude runs out, the task that hit the limit carries its conversation over to GPT in the same tab and keeps going, and new tabs start on GPT until Claude resets. Turn this off with `limits.fallback_to_gpt: false`.

**Questions:** the agent can stop and ask you something. It shows as a card with options in the app and as a numbered question in a linked terminal; answer in either.

**/subagents:** describe the subagents you want, or leave it empty and the Fable advisor looks at the project and suggests some. You review each proposal and pick which to add. They're saved in `subagents.yaml`, and GPT-based ones run through a Sonnet coordinator that calls GPT.


```bash
npm run desktop           # run it from this folder
npm run desktop:mac       # build "Multi-Agent Harness.dmg" into release/
npm run desktop:win       # build the Windows installer into release/
```

Build the installer on the platform you'll use it on, since each one bundles that platform's Claude and Codex programs.

- **Chats:** listed in the sidebar, grouped by date. Search with ⌘K. Double-click the title to rename a chat.
- **Agent cards:** each handoff shows up as a card with the agent and its model. Click a card to see its steps.
- **Verifier:** a "Verified" badge appears when Fable checks the work. If it finds problems, click the badge to see them.
- **Fork:** opens the copied chat in its own window.
- **btw:** answers side questions in a side panel, even while a turn is running.
- **Folder:** the folder at the bottom of the sidebar is where agents work. Click it to switch projects. Each folder has its own chats.
- **GitHub approval:** shown as a native Approve/Deny dialog.
- **Sign-in:** if Claude isn't signed in with a subscription, the app shows a sign-in screen instead of running.
- **First launch:** the installed app keeps its settings, UI links and evals in `~/.agent-harness`.

The terminal version (`npm start`) runs on the same engine and has the same commands.

## Commands

Name a connected app with `@` anywhere in a message, for example `@pally find my open tasks` or `post this summary to @slack`. Typing `@` lists your connected apps. The agent is told to use that app's tools for the request.

| Command | What it does |
|---|---|
| `/models` | Pick the model for each role, and which models the model picker offers. Saved to `harness.config.yaml`. |
| `/fork [title]` | Copies this chat and opens the copy in a **new terminal window** (tmux, macOS Terminal or iTerm, Windows Terminal, or a Linux terminal). `--here` switches to the copy in place instead. |
| `/btw <q>` | Asks a side question on a throwaway copy of the chat. Works while a turn is running and never changes the main chat. |
| `/change <correction>` | Correct the running task without stopping it (⌘Enter in the app) |
| `/context` | Context window grid by category |
| `/docs` `/summarize <file>` | Documents and their main points |
| `/new` `/chats` `/resume <id or #>` `/rename` `/compact` `/stop` | Manage chats |
| `/advisor` `/code` `/research` `/test` `/image` `/video` | Send a task straight to one specialist |
| `/subagents [describe \| suggest \| remove <name>]` | Make your own subagents |
| `/tabs` `/tab <n>` `/detach` | Terminal linked to the app |
| `/design [q]` | Search your UI links (include `swift` to see the SwiftUI ones) |
| `/remember` `/recall` | Save to or search long-term memory |
| `/usage` | Claude plan usage, ChatGPT status |
| `/connections` (`/mcp`, `/apps`) | MCP servers and apps |
| `/status` `/agents` `/model` `/verify on\|off` `/eval` | Inspect and control the harness |

Both apps share one command list (`src/commands.ts`). `/help` and the `/` menu also list every installed skill and plugin command, such as Superpowers, gstack and taste-skill, read live from the session. Typing part of a name finds plugin commands too: `/brain` finds `/superpowers:brainstorm`. Any other `/command` goes straight to the agent.

Flags: `--resume <id>`, `--continue`, `-p "prompt"` (one turn, no chat window), `--model <id>`, `--no-verify`.

## Approvals and safety

- Everything runs without asking you, **except GitHub pushes**. Before any `git push` or GitHub write (creating a PR, pushing files, merging), the harness stops and asks `[y/N]`.
- Pushes and writes to `main` or `master` are always refused (`approvals.protected_branches`).
- Bash runs in the SDK sandbox (bubblewrap on Linux, Seatbelt on macOS). For full isolation, run everything in Docker with `docker compose run --rm harness`. Agents then see only `./workspace`.

## Evals

`npm run eval` (or `/eval [filter]`) runs `evals/tasks/*.yaml`. Each task can check:

- `expect_agent`: the task went to the right specialist
- `contains` / `regex`: text that must appear in the answer
- `judge`: a rubric graded by Fable

Results are saved to `evals/results/`. Re-run the evals after you change a model or prompt.

## Layout

```
src/engine.ts           chat engine shared by both apps: turns, verifier loop, /btw, /fork
src/commands.ts         one command list for both apps, merged with skill/plugin commands
src/host.ts             open tabs, each with its own engine (desktop app)
src/bridge.ts           local link that lets a terminal join the app's tabs
src/gpt-chat.ts         GPT chat engine (Codex, ChatGPT plan)
src/codex.ts            runs Codex turns and parses its JSON events
src/subagents.ts        /subagents storage and the advisor's design prompt
src/tools/gpt.ts        ask_gpt and image tools for the Claude team
src/connections.ts      MCP servers & apps: status, add, turn off
src/usage.ts            Claude plan usage windows and the GPT switch rule
src/docs.ts             Documents pane: listing, PRD detection, summaries
src/cli.ts              terminal app
src/desktop/main.ts     desktop app (Electron main process)
desktop/renderer/       desktop window UI
desktop/preload.cjs     bridge between the window and the engine
src/session.ts          SDK options: models, agents, MCP, plugins, hooks, sandbox
src/agents.ts           subagent definitions (model per role)
src/guards.ts           push approval and stuck detection
src/mcp.ts              external MCP servers
src/tools/              design_library, gui_test (GPT-6 Astra via Codex)
src/subscription.ts     subscription-only checks, API-key stripping
src/terminal.ts         opens /fork in a new terminal window
src/eval.ts             eval runner
harness.config.yaml     models, effort levels, approvals, sandbox, MCP switches
```
