# Agent harness

A standalone terminal app built on the Claude Agent SDK. You chat with one orchestrator, which hands work to specialists on different models.

| Role | Model | Used for |
|---|---|---|
| Orchestrator | Claude Opus 5.5 | Plans, delegates and combines the results. It doesn't do the work itself. |
| Advisor | Claude Fable 5.1 | Used when the agent is stuck (after 3 tool failures in a row) or faces a hard decision |
| Coder, designer | Claude Fable 5.1 | All coding and UI work |
| Researcher | Claude Sonnet 5.5 | Scraping, research and general tasks |
| Summarizer | Claude Sonnet 5.5 | Shortens long pages and logs before the orchestrator reads them |
| GUI tester | GPT-6 Astra via Codex CLI | Browser testing. Codex drives Playwright on your ChatGPT plan. Falls back to Claude + Playwright MCP if Codex fails or isn't signed in. |
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

## Commands

| Command | What it does |
|---|---|
| `/fork [title]` | Copies this chat and opens the copy in a **new terminal window** (tmux, macOS Terminal or iTerm, Windows Terminal, or a Linux terminal). `--here` switches to the copy in place instead. |
| `/btw <q>` | Asks a side question on a throwaway copy of the chat. Works while a turn is running and never changes the main chat. |
| `/new` `/chats` `/resume <id or #>` `/rename` `/compact` `/stop` | Manage chats |
| `/advisor` `/code` `/research` `/test` `/video` | Send a task straight to one specialist |
| `/design [q]` | Search your UI links (include `swift` to see the SwiftUI ones) |
| `/remember` `/recall` | Save to or search long-term memory |
| `/status` `/agents` `/model` `/verify on\|off` `/eval` | Inspect and control the harness |

Any other `/command`, such as Superpowers or gstack's `/review`, `/qa` and `/ship`, goes straight to the agent.

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
src/cli.ts              REPL, slash commands, verifier loop
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
