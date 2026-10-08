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

### Develop and debug

After `npm ci`, start the backend in one terminal:

```powershell
npm run dev
```

This runs the backend on **http://127.0.0.1:4317**, prints readable timestamped logs and restarts when backend source files change. Start the frontend in a second terminal:

```powershell
npm run dev:web
```

Open **http://127.0.0.1:5173** for frontend hot updates. Vite proxies API requests to backend port 4317. Browser developer tools (F12) show frontend console messages and network requests. `npm run build` is needed to update the frontend served directly by the backend; Vite development uses source files.

For backend breakpoints, use `npm run debug` in place of `npm run dev`. It also watches source files, enables debug-level logs and exposes the Node inspector on **127.0.0.1:9229**. Open `chrome://inspect` or `edge://inspect`, add `localhost:9229` under Configure if necessary, then inspect the Node target. The Sources panel provides TypeScript source maps and breakpoints. Reattach after a backend restart. Use Ctrl+C in each terminal to stop development servers. Restarting interrupts active Runs; the usual recovery rules apply.

`npm start` prints structured JSON logs at `info` level. Development commands use `pino-pretty` for readable output. Logs include startup/shutdown, request IDs, route patterns, HTTP status and duration, Run start/end and operational errors; debug logging also includes request starts and Run phase updates. Request bodies, headers, query values, model replies and task specifications are omitted. Errors use the existing credential redaction rules. Detailed model/tool output remains in the conversation and activity UI.

Override the log level with `npm run dev -- --log-level=debug` or set `$env:PHANTOM_LOG_LEVEL = 'debug'` before `npm start`. Accepted levels are `trace`, `debug`, `info`, `warn`, `error`, `fatal` and `silent`; command-line options take precedence over the environment. `npm start -- --help` lists startup options without opening the database.

To develop against separate, initially empty data, use `npm run dev -- --data-dir=.phantom/dev` (or the same option with `debug`/`start`). This selects a separate database and managed workspaces without adopting existing checkout-local data. The normal default remains `%USERPROFILE%\.phantom`. Development and debug modes run the real Engine, so permissions granted in the selected data directory still govern repository actions.

During discussion, the PM can persist glossary/ADR drafts locally using the upstream document formats. Accepted documents accompany the corresponding implementation as immutable snapshots; `revise_task` can explicitly replace accepted snapshots before delivery. A requirement normally produces one Task, including its documentation. Discussion alone never authorizes implementation. PM contexts refresh from managed default-branch views.

## Controls

Saving role settings performs local schema, Provider-reference and recent model-capability checks without launching an Agent or contacting an upstream. Unchanged assignments are preserved. Model lists refreshed in the editor are shared for five minutes; editing a Provider connection invalidates its cached capabilities. New custom models require discovery or explicit custom-model selection. Changed assignments that have not passed a recent connection check are saved with a first-Run verification notice.

Use **Check Codex role configurations** in the Codex model section for an explicit read-only connection and effective-configuration check. Identical Provider/model/effort combinations are checked once; the UI shows the current role, limits each check to 15 seconds and stops waiting after 30 seconds overall. Checking does not save settings, execute a model turn or block other settings writes. Actual Runs still verify their resolved Provider, model and reasoning effort before execution.

- Closing a work switch stops new claims; existing tasks finish development, review, revision and merge. Pause interrupts a task separately; cancel retains its branch, worktree and PR.
- Global/project/repository Dev limits apply together. Defaults: 4 / 4 / 2. Independent Review has a separate global two-session limit; PM activity is separate.
- New Projects inherit the software's default Agent (OMP). A Project can select OMP or Codex, and each role can inherit its global model or pin a local assignment. OMP models are initialized once from its `default`, `slow` and `advisor` roles. Existing Projects retain explicit Codex assignments. Runs fix their resolved configuration; changing settings does not rewrite history or silently substitute models.
- Normal Tasks receive one combined primary review. Complex work, rework or primary escalation requires a second, different model. Current tests, required reviews and remote revision/check evidence govern automatic merge; no additional PM merge-approval turn is needed.
- Each task uses a managed branch and worktree. The original checkout is not used for development. Dev leaves implementation files for host-owned staging, commit and formal validation. A durable finalization checkpoint lets interrupted host work resume without another Dev session. Known Git/process/environment failures pause without consuming product rework attempts; actual test/review failures still require corrections. Reviews bind both base and head revisions. The host verifies configured tests and GitHub checks before requesting squash merge; branch protection is not bypassed.
- PM owns technical decisions. Product ambiguity and unavailable external authority remain user decisions. Skill confirmation points are adapted to this delegation in `prompts/`.

## State and recovery

`%USERPROFILE%\.phantom` is the Windows data root (`~/.phantom` on other hosts). It contains `config.json`, `phantom.sqlite`, managed `workspaces/`, image `messages/`, protected credentials, `agents/omp/sessions/` and backups. On first startup the host checks checkout-local data, creates a consistent SQLite backup and adopts authoritative referenced files. Existing dirty or paused worktrees retain explicitly recorded legacy paths; newly created worktrees use the home root. Preserve the old directory and `migration.json` rollback information until you have verified your migrated projects.

On startup, unfinished Runs become interrupted and durable recovery items are reconciled before new claims. Each Project selects automatic continuation (default) or manual continuation; user-paused work remains paused. Incidents preserve redacted failure evidence and trigger one PM assessment, while product Clarifications retain their source intent and answers. Queue sends a later PM turn; Steer addresses the current one. Unknown external outcomes require evidence before retry: OMP currently cannot prove a lost steering acknowledgement through RPC history, so those requests remain uncertain. Do not delete the database as a recovery shortcut.

The UI supports Chinese and English, system/light/dark appearance, a collapsible project sidebar, board/list Task views, role configuration, recovery actions and resource statistics. Completed PM work processes fold while questions and final answers remain visible. Use the right-side turn rail to preview and jump through conversation history; narrow windows provide a conversation outline instead. PNG/JPEG/WebP attachments have no application-imposed count or file-byte cap; image decoding retains a 25-million-pixel limit, and model backends can reject unsupported inputs. Reported Run tokens, account allowance and estimated cost are separate; absent fields remain unknown, and official account access is not billed using public API prices. Completed worktrees are removed only after verified handoff and safety checks; cleanup failures remain visible maintenance outcomes.

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
