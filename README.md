# Phantom Circuit

A Windows-first, self-hosted AI engineering orchestrator. Discuss requirements with a project PM, open a repository's work switch, and let isolated Dev and Review sessions work toward a verified PR merge. GitHub remains the engineering record; the local Web app handles conversation, execution and experience feedback.

## Run locally

Requirements: Node.js 24+, Git, PowerShell 7+ (`pwsh.exe` on PATH on Windows), GitHub CLI (`gh auth login`) and Codex CLI with an authenticated account. This implementation was developed against Codex CLI 0.154.0. Target repositories must already have a local checkout whose `origin` matches GitHub. Configured install/build/test commands use PowerShell 7 on Windows, including `&&` chains.

```powershell
npm ci
npm run build
npm start
```

Open **http://127.0.0.1:4317**. Create a project, connect a repository and explicitly grant its engineering permissions. Repositories start with new task claims disabled. Ask the PM to inspect project scripts and configure install/build/test/start commands before opening work. `聊一聊` never authorizes tasks; `交给 PM 做` and `体验反馈` do. No sample data is inserted into the real workspace.

Use `npm run dev:web` in a second terminal for frontend development. The Vite development server proxies API requests to port 4317.

During discussion, the PM can persist glossary/ADR drafts locally using the upstream document formats. Accepted documents are attached as immutable snapshots to a documentation task under an explicit implementation request, then published through the normal Dev/review/merge loop. Discussion alone never starts a documentation Dev. PM contexts refresh from managed default-branch views so merged decisions are not read from a stale original checkout.

## Controls

- Closing a work switch stops new claims; existing tasks finish development, review, revision and merge. Pause interrupts a task separately; cancel retains its branch, worktree and PR.
- Global/project/repository Dev limits apply together. Defaults: 4 / 4 / 2. Independent Review has a separate global two-session limit; PM activity is separate.
- Backend defaults to `gpt-5.6-luna / max`; frontend and ordinary fullstack to `gpt-6-astra / low`; complex work, PM and Review to `gpt-6-astra / medium`. The host checks model availability and effort support; it does not silently substitute models.
- Each task uses a managed branch and worktree. The original checkout is not used for development. Dev leaves implementation files for host-owned staging, commit and formal validation. A durable finalization checkpoint lets interrupted host work resume without another Dev session. Known Git/process/environment failures pause without consuming product rework attempts; actual test/review failures still require corrections. Reviews bind both base and head revisions. The host verifies configured tests and GitHub checks before requesting squash merge; branch protection is not bypassed.
- PM owns technical decisions. Product ambiguity and unavailable external authority remain user decisions. Skill confirmation points are adapted to this delegation in `prompts/`.

## State and recovery

`.phantom/config.json` contains the local port. `.phantom/phantom.sqlite` stores project configuration, routing, conversation messages, tasks, runs, events and external operation records. `.phantom/workspaces/` contains managed bare repositories, task worktrees and previews. Secrets are not stored as project configuration. Back up `.phantom/` and Codex's own persisted sessions with the service stopped to preserve both host and conversation history.

On startup, unfinished runs are marked interrupted and their tasks pause for worktree/remote verification. Resume preserves pending work. An external mutation whose result is unknown is queried remotely before retrying; if it cannot be reconciled, it remains blocked rather than creating duplicates. Do not delete the database as a recovery shortcut.

## Local experience environments

Set the repository's startup command, port and validation commands in its configuration (or ask the PM). `{port}` is replaced in the startup command; `PORT` is also passed to that child process. The preview uses a separate worktree at the merged default branch. Builds/installations run locally; processes have output logs and bounded HTTP readiness checks. A busy port or unsuccessful start is shown explicitly. There is no automatic production deployment.

## Engineering skills

The 14 bundled Matt Pocock skills and referenced files are pinned in `.agents/skills/manifest.json`. PM uses discussion, domain-modeling, specification and ticket skills; Dev uses implement/TDD/debugging; independent Review uses Standards and Spec axes. The host owns scheduling and external effects. To restore the exact bundled revision:

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

`npm run probe -- --turn` additionally makes two metered Codex calls to verify a model response and conversation recovery across process restart. It does not mutate repositories.

`npx tsx scripts/pm-smoke.ts` makes one metered PM call with the real role prompt, bundled skill context and registered host tools, using a temporary project without repositories or GitHub writes.

Tests use real temporary Git repositories, commits, worktrees and test commands, with model/GitHub boundaries simulated for lifecycle scenarios. Passing them does not prove a real GitHub merge under your account's branch protection. Actual remote lifecycle acceptance requires a repository explicitly connected and authorized by its owner. The current session has not created a remote source repository or modified a user's existing GitHub project.

## MVP boundaries

Single user, loopback-only local service, trusted repositories, Windows-native execution. Worktrees and prompts do not provide container-level protection against hostile repository code. No cloud worker fleet, multi-user access, production deployment or alternate Agent runtime is included. Arbitrary project stacks need valid command configuration; unsupported model/permissions states are surfaced instead of hidden by fallbacks.
