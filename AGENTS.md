# Phantom Circuit engineering

Use the pinned Matt Pocock skills in `.agents/skills/`. Preserve user changes, inspect before changing, and verify observable behavior. Do not change the upstream skill files as application configuration; project adaptations live in `prompts/` and the host tool boundaries.

## Agent skills

- Issue tracker: target projects use GitHub through the host broker; see `docs/agents/issue-tracker.md`.
- Domain docs: root `CONTEXT.md` is vocabulary only; `docs/adr/` records consequential decisions. Read relevant ADRs before changing behavior.
- Testing seams: public Store scheduling/state operations, HTTP API, GitHub adapter boundary, Codex protocol, complete Engine lifecycle with real temporary Git repositories, and browser-visible behavior. These seams are approved for this implementation. Test failures before fixes; avoid implementation-mirroring assertions.
- Use `npm test`, `npm run check`, `npm run build`, and `npm run test:browser`. `npm run probe` is read-only capability verification. `npm run probe -- --turn` makes metered model calls without repository writes.

## Scope and authorization

Do not create remote repositories, push this source checkout, or mutate unrelated repositories without authorization. All runtime GitHub writes require explicit per-repository onboarding authorization. Work switches govern new claims only. Review and merge operate on pinned revisions. Do not weaken branch protection or claim that worktrees are security sandboxes.

Windows is the supported MVP platform. Keep state and managed workspaces under `.phantom/`; do not write credentials to logs or tracked files. Runtime adapters must preserve the user's original checkout.
