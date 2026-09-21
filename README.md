# Phantom Circuit

A Windows-first, self-hosted AI engineering orchestrator. Discuss requirements with a project PM, open a repository's work switch, and let isolated Dev and Review sessions work toward a verified PR merge. GitHub remains the engineering record; the local Web app handles conversation, execution and experience feedback.

## Run locally

Requirements: Node.js 24+, Git, PowerShell 7+ (`pwsh.exe` on PATH on Windows), GitHub CLI (`gh auth login`), and an authenticated Oh My Pi (`omp`) installation. Codex CLI is an optional backend. The adapters have been exercised with OMP 18.1.19 and Codex app-server; run the capability probes for your installed versions. Target repositories must already have a local checkout whose `origin` matches GitHub. Configured install/build/test commands use PowerShell 7 on Windows, including `&&` chains.

```powershell
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4317**. Create a project, connect a repository and explicitly grant its engineering permissions. Repositories start with new task claims disabled. Ask the PM to inspect project scripts and configure install/build/test/start commands before opening work. `聊一聊` never authorizes tasks; `交给 PM 做` and `体验反馈` do. No sample data is inserted into the real workspace.

Use `npm run dev:web` in a second terminal for frontend development. The Vite development server proxies API requests to port 4317.

During discussion, the PM can persist glossary/ADR drafts locally using the upstream document formats. Accepted documents accompany the corresponding implementation as immutable snapshots; `revise_task` can explicitly replace accepted snapshots before delivery. A requirement normally produces one Task, including its documentation. Discussion alone never authorizes implementation. PM contexts refresh from managed default-branch views.

## Controls

- Closing a work switch stops new claims; existing tasks finish development, review, revision and merge. Pause interrupts a task separately; cancel retains its branch, worktree and PR.
- Global/project/repository Dev limits apply together. Defaults: 4 / 4 / 2. Independent Review has a separate global two-session limit; PM activity is separate.
- New Projects inherit the software's default Agent (OMP). A Project can select OMP or Codex, and each role can inherit its global model or pin a local assignment. OMP models are initialized once from its `default`, `slow` and `advisor` roles. Existing Projects retain explicit Codex assignments. Runs fix their resolved configuration; changing settings does not rewrite history or silently substitute models.
- Normal Tasks receive one combined primary review. Complex work, rework or primary escalation requires a second, different model. Current tests, required reviews and remote revision/check evidence govern automatic merge; no additional PM merge-approval turn is needed.
- Each task uses a managed branch and worktree. The original checkout is not used for development. Dev leaves implementation files for host-owned staging, commit and formal validation. A durable finalization checkpoint lets interrupted host work resume without another Dev session. Known Git/process/environment failures pause without consuming product rework attempts; actual test/review failures still require corrections. Reviews bind both base and head revisions. The host verifies configured tests and GitHub checks before requesting squash merge; branch protection is not bypassed.
- PM owns technical decisions. Product ambiguity and unavailable external authority remain user decisions. Skill confirmation points are adapted to this delegation in `prompts/`.

## State and recovery

`%USERPROFILE%\.phantom` is the Windows data root (`~/.phantom` on other hosts). It contains `config.json`, `phantom.sqlite`, managed `workspaces/`, image `messages/`, protected credentials, `agents/omp/sessions/` and backups. On first startup the host checks checkout-local data, creates a consistent SQLite backup and adopts authoritative referenced files. Existing dirty or paused worktrees retain explicitly recorded legacy paths; newly created worktrees use the home root. Preserve the old directory and `migration.json` rollback information until you have verified your migrated projects.

On startup, unfinished Runs become interrupted and durable recovery items are reconciled before new claims. Each Project selects automatic continuation (default) or manual continuation; user-paused work remains paused. Incidents preserve redacted failure evidence and trigger one PM assessment, while product Clarifications retain their source intent and answers. Queue sends a later PM turn; Steer addresses the current one. Unknown external outcomes require evidence before retry: OMP currently cannot prove a lost steering acknowledgement through RPC history, so those requests remain uncertain. Do not delete the database as a recovery shortcut.

The UI supports Chinese and English, board/list Task views, role configuration, recovery actions and resource statistics. Reported Run tokens, account allowance and estimated cost are separate; absent fields remain unknown, and official account access is not billed using public API prices. Completed worktrees are removed only after verified handoff and safety checks; cleanup failures remain visible maintenance outcomes.

## Local experience environments

Set the repository's startup command, port and validation commands in its configuration (or ask the PM). `{port}` is replaced in the startup command; `PORT` is also passed to that child process. The preview uses a separate worktree at the merged default branch. Builds/installations run locally; processes have output logs and bounded HTTP readiness checks. A busy port or unsuccessful start is shown explicitly. There is no automatic production deployment.

## Engineering skills

The 14 bundled Matt Pocock skills and referenced files are pinned in `.agents/skills/manifest.json`. Project adaptations in `prompts/` use a combined independent review and risk-based escalation; upstream skill files are preserved. The host owns scheduling and external effects. To restore the exact bundled revision:

```powershell
npm run skills:install
```

Source: https://github.com/mattpocock/skills at `3cca18b368ae95cdbdebbff572ccafa662551015`. Retain upstream attribution and the downloaded license when redistributing.

## Verification

```powershell
npm test
npm run check
npm run build
npm run test:browser
npm run probe
```

Browser checks use a fresh headless Edge profile on Windows and a separate in-memory fixture server on port 4318. Screenshots go to ignored `test-results/`; fixture projects never enter the real database. On other platforms install Playwright Chromium first.

`npm run probe` checks OMP by default; use `-- --agent codex` for Codex. Adding `--turn` makes metered model calls to verify a response and session recovery across process restart in a temporary directory, without repository writes.

`npx tsx scripts/pm-smoke.ts` makes one metered PM call with the real role prompt, bundled skill context and registered host tools, using a temporary project without repositories or GitHub writes.

Tests use real temporary Git repositories, commits, worktrees and test commands, with model/GitHub boundaries simulated for lifecycle scenarios. Passing them does not prove a real GitHub merge under your account's branch protection. Actual remote lifecycle acceptance requires a repository explicitly connected and authorized by its owner.

## MVP boundaries

Single user, loopback-only local service, trusted repositories, Windows-native execution. Worktrees and prompts do not provide container-level protection against hostile repository code. OMP and Codex are supported; cloud workers, multi-user access and automatic production deployment are outside this implementation. Arbitrary project stacks need valid commands; unsupported model/permission states are surfaced explicitly.
