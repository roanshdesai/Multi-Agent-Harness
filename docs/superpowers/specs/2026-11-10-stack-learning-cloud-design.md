# Model stack, self-learning, and /cloud: design

Date: 2026-11-10. Approved by the owner to build ("no PRD required"). Three independent parts, built in this order: 1. model stack, 2. self-learning, 3. `/cloud`.

Read `CONTEXT.md` first (hard rules: subscriptions only, only GitHub pushes need approval, never push to `main` from `roansh-desai`, never commit `.env`/tokens/personal info, UI must look original: no gradients, glows, glass or emoji).

---

## 1. Model stack

### Intent
Fable 5.2 (`claude-fable-5-2`, offered on the owner's Claude plan, checked with `q.supportedModels()`) is the strongest model. The owner wants it where judgement matters most: coordinating subagents, advising, and 3D CAD. Coding stays on Fable 5.1, with a cheaper Sonnet coder for easy work, because the owner's Claude 5-hour window ran out fast (85% in one day).

### Decided
| Role | Model | Change |
|---|---|---|
| Orchestrator (`models.main`) | `claude-fable-5-2` | was `claude-opus-5-5`. It only coordinates and delegates (already enforced in `ORCHESTRATOR_PROMPT`). |
| Advisor (`models.advisor`) | `claude-fable-5-2` | was `claude-fable-5-1`. Both the server-side advisor tool and the `advisor` subagent. |
| CAD specialist (new role `models.cad`) | `claude-fable-5-2` | new |
| Coder (`models.coder`) | `claude-fable-5-1` | unchanged |
| Quick coder (new role `models.quick_coder`) | `claude-sonnet-5-5` | new |
| Verifier | `claude-fable-5-1` | unchanged |
| Fallback chain | `claude-opus-5-5`, `claude-sonnet-5-5` | unchanged (Fable 5.2 busy → Opus → Sonnet) |

- **Quick coder:** a separate subagent, picked by the orchestrator up front for clearly mechanical, well-scoped edits (renames, bulk edits, tests following an existing pattern, small fixes with a known location). No mid-task model switching. When a job splits into "decide" and "apply", the orchestrator sends the deciding to `coder` and the applying to `quick-coder` as two tasks, passing the coder's exact file/line plan so the quick coder doesn't re-explore. (Owner's goal: Sonnet must not burn usage re-reading context.)
- **CAD specialist (`cad`):** the owner models in **Onshape** (example: the OilSense sensor housing, PETG, 3D printed). The agent advises on the design (fit, wall thickness, printability, where parts go) and writes **FeatureScript** the owner pastes into Onshape. It does not call the Onshape API in this version.
- Both new roles appear in `/models`, the Team pane, `agentRunsOn`, and `harness.config.yaml`, like the existing roles.
- **The owner's data-folder config** (`~/.agent-harness/harness.config.yaml`) has its own `models:` values, which win over the bundled defaults. Update the four changed/new entries there too (via `saveModels`, keeping comments), or the installed app keeps the old models.

### Left to the builder
The CAD and quick-coder prompts, tool allowlists, and effort levels (suggested: cad `xhigh`, quick_coder `low`).

---

## 2. Self-learning ("instincts")

### Intent
"The more I code, the more it learns from me." Modelled on ECC's continuous-learning-v2 (github.com/affaan-m/ecc, `skills/continuous-learning-v2`), adapted to this harness. Hindsight already remembers facts and decisions per project; instincts are different: **how the owner wants work done**, learned from corrections and habits.

### Decided
- **What is learned:** corrections the owner gives ("don't move anything on disk", "no gradients"), preferences stated once (plain words, no jargon), fixes that worked, and repeated workflows. Source is mainly the owner's own messages plus what the agents did right before.
- **Sources:** the harness's own chats (Claude and GPT tabs) and the owner's Claude Code sessions in the folders of their projects (`~/.claude/projects`, the same transcripts the token stats read). Subagent transcripts are skipped; the orchestrator's chat already shows the owner's corrections.
- **When:** not on every tool call. When a chat goes idle (turn ended, no new message for a few minutes) or is closed, one extraction pass runs over the new part of that chat on **Haiku 5.5** (subscription). Each chat is processed once per new chunk of conversation.
- **Instinct record:** `id`, `trigger` (when it applies), `action` (what to do), `evidence` (short quotes and the chat id), `confidence` (0.3–0.9), `scope` (`project` or `global`), `project` (bank id), `created`, `last_seen`, `hits`.
- **Scope:** project by default; global when it's clearly about the owner in general (push rules, writing style). An instinct seen in two or more projects at confidence ≥ 0.8 is promoted to global.
- **Confidence:** starts at 0.3–0.5. Rises each time it's seen again without objection (suggested +0.1). Drops sharply on an explicit correction (suggested −0.3). Decays if unseen for 30 days. Below 0.3 it's dropped.
- **Use:** at the start of each chat, the orchestrator gets the project's and global instincts at confidence ≥ 0.7, best first, at most 8, as a short block in its prompt. It passes the relevant ones on in subagent briefs. 0.5–0.7 instincts are not injected.
- **Storage:** small JSON files, `<data folder>/.harness/instincts/global.json` and `<data folder>/.harness/instincts/<bank id>.json` (bank id from `bankFor(cwd)`, so instincts follow projects the same way memory does). Local only; never sent anywhere. Not in git.
- **UI:** a "Learned" section in the sidebar's Memory tab listing instincts (trigger → action, confidence, scope) for the current project and global, with edit and delete. A `/learned` command shows the same in the terminal.
- **Not in this version:** ECC's `/evolve` (clustering instincts into skills), import/export.

### Left to the builder
The extraction prompt, the exact idle delay, dedupe/merge of similar instincts, and the injection wording.

---

## 3. `/cloud`

### Intent
The owner works on a laptop that goes in a bag. `/cloud` hands the current task to a Claude cloud session (claude.ai/code) so it keeps running while they're out, and they follow it on the Claude phone app. Back at the Mac, the same harness tab continues the cloud's work locally. Claude only; Codex cloud was considered and dropped.

### Decided
**Sending (`/cloud` in a tab):**
1. Requires the tab's folder to be a GitHub repo. Otherwise say so and stop.
2. Stop the local work at a safe point (as `/stop`, waiting for a running tool call to finish).
3. Write the hand-off note with the existing `/handoff` summary (`context.md`): the task, what's done, what's left, decisions, open questions.
4. Export the project's Hindsight memory to `.cloud/memory.md`: the project's knowledge pages (architecture, conventions, decisions, initiatives) plus memories recalled for the current task. Not every raw memory.
5. **Secret scan** `.cloud/memory.md` and the hand-off note before committing: remove anything that looks like a key, token or password; never include `.env`.
6. **Public repo check:** if the GitHub repo is public, stop and ask before pushing memory.
7. Commit the unfinished work plus `.cloud/` to a new branch `cloud/<YYYY-MM-DD>-<short-task-slug>`, never `main`, and push it. The normal push approval applies (unchanged rule).
8. Start the cloud session with `claude --cloud "<instructions>"`, telling it to check out that branch, read `.cloud/context.md` and `.cloud/memory.md` first, keep committing to the same branch, and finish with a summary of what it did.
9. The tab shows "Continued in the cloud", with the claude.ai/code link and the branch. The tab remembers the cloud session id and branch.

**What gets committed and where the Mac ends up (builder's call, recorded):**
- The cloud branch starts from the tab's current branch and HEAD. It takes every uncommitted change in the folder (tracked and untracked, `.gitignore` respected, `.env` always excluded). The push approval shows the file list first, so the owner sees exactly what goes up.
- After pushing, the Mac switches back to the original branch with a clean tree (the work now lives on the cloud branch), so nothing local is lost or half-applied.
- Instincts at confidence ≥ 0.7 (project + global) go into the hand-off, so the cloud session follows the owner's learned preferences. This is the one exception to "instincts stay local", and they are secret-scanned like the rest.

**While the cloud runs:** the tab is in a "In the cloud" state: no new messages there, but other tabs work normally. The cloud session id, URL and branch are saved with the tab's chat so they survive an app restart.

**Coming back (on the Mac, same tab):**
- A "Continue here" action on that tab (and `/cloud back`): fetch and check out the cloud branch locally, read the cloud session's final summary, and continue in the same tab as a fresh session started from the hand-off plus that summary (like "Continue in a new chat"), because the old chat may already be near its context limit.
- What the cloud did is saved into the project's Hindsight bank (one ingested summary), so memory stays complete.
- After "Continue here" has the work locally, the harness deletes the `cloud/...` branch from GitHub (a push, so it asks for approval). That removes the memory file's history from GitHub along with the branch. The owner asked for memory to go to the repo; this keeps it from staying there.
- If the owner declines at the public-repo check, `/cloud` still goes ahead with the hand-off note only (no `memory.md`).
- `.cloud/` is removed from the branch before it is merged anywhere, so the memory file never reaches `main`.

**Rules kept:** subscriptions only (Claude cloud is on the Claude plan); only the push asks for approval; never push to `main`; no secrets or personal info committed.

### Left to the builder
- How `claude --cloud` picks the repo and branch (check Claude Code 2.1.322's behaviour: whether it uses the current git remote and branch, and needs `--environment`). If it can't target a branch, put the branch in the instructions.
- How to read a cloud session's state and final summary (`--teleport`, or the session URL). If it isn't readable, "Continue here" pulls the branch and asks the owner to paste or confirm the summary.
- The secret-scan patterns.

---

## Testing (all three)
`npx tsc --noEmit && npm test` after every change; add `node:test` cases next to the existing ones in `test/core.test.ts`: new roles in `buildAgents`/`agentRunsOn`; instinct confidence rules, scope and promotion, the injection cap and threshold; `/cloud` branch naming, public-repo refusal, secret scrubbing, and `.cloud/` removal (with a fake `claude` binary like `test/fixtures/fake-codex.mjs`). Real cloud runs are tested on the owner's Mac.
