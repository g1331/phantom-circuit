# Phantom Circuit engineering

Preserve user changes, inspect before changing, and verify observable behavior. Keep orchestration low-intrusion: host prompts define roles, task context, permissions and delivery contracts; engineering methods follow the target repository's conventions and explicitly adopted team instructions.

## Engineering references

- Issue tracker: target projects use GitHub through the host broker; see `docs/agents/issue-tracker.md`.
- Domain docs: root `CONTEXT.md` is vocabulary only; `docs/adr/` records consequential decisions. Read relevant ADRs before changing behavior.
- Testing seams: public Store scheduling/state operations, HTTP API, GitHub adapter boundary, Codex protocol, complete Engine lifecycle with real temporary Git repositories, and browser-visible behavior. These seams are approved for this implementation. Test failures before fixes; avoid implementation-mirroring assertions.
- Verification must match the change: reuse existing checks and run the smallest relevant set. Add a focused regression only when it captures a distinct failure; avoid redundant cases, one-off browser harnesses and full-suite runs for small changes. Broader checks are warranted by affected behavior or an explicit request.
- Available checks: `npm test`, `npm run check`, `npm run build`, and `npm run test:browser`. `npm run probe` is read-only capability verification. `npm run probe -- --turn` makes metered model calls without repository writes.

## Local development and runtime

- `npm run dev` starts the watched backend and Vite together; `npm run debug` also enables the Node inspector. Use **http://127.0.0.1:5173** for the development UI. `npm run dev:server` and `npm run dev:web` start each side separately.
- In development, the backend on port 4317 redirects web GET/HEAD requests to Vite on port 5173 with an uncached temporary redirect. API requests stay on the backend. Do not serve an older `dist` UI alongside the development UI.
- `npm run build` produces `dist`; `npm start` serves that build and the API on port 4317 by default, without starting Vite. Source changes alone do not update `dist`. The selected data directory can configure a different backend port.
- Development runs the real Engine against `%USERPROFILE%/.phantom` (Windows) or `~/.phantom` (Linux) by default. Use `--data-dir=.phantom/dev` for separate development state. Restarting interrupts active Runs; keep verification isolated from the user's running instance and original data.

## Scope and authorization

Do not create remote repositories, push this source checkout, or mutate unrelated repositories without authorization. All runtime GitHub writes require explicit per-repository onboarding authorization. Work switches govern new claims only. Review and merge operate on pinned revisions. Do not weaken branch protection or claim that worktrees are security sandboxes.

Windows and Linux are supported. For installed releases or Linux service changes, read `docs/adr/0015-installed-runtime-and-linux-service.md` and verify the production-pruned artifact outside the checkout. Keep state and managed workspaces under `.phantom/`; do not write credentials to logs or tracked files. Runtime adapters must preserve the user's original checkout.
