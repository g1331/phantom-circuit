# M2 owner continuity

This isolated acceptance targets `acceptance/m2-owner-continuity`.
One read-only backend contribution inspected the implementation behind these facts.

Each Task retains one persistent owner, workspace, saved native session, and recorded
backend/profile. Subsequent work resumes that session; reassignment clears its binding
(`Store.ownerSource`, `Store.ownerRun` in `src/server/store.ts`).

The owner may commission bounded temporary contributions with an objective, capability
profile, and read/write mode. Private worktrees and existing Run capacity support these
assignments; results return to the owner, who explicitly integrates code contributions
(`src/server/collaboration.ts`). Ownership stays with the owner.

Authorized bound feedback retains its native identity and revision and is judged in the
owner's work session. In-scope corrections continue the same work; scope changes seek
clarification (`src/server/follow-ups.ts`, `Engine.evaluateFeedback` in `src/server/engine.ts`).

The host owns commits, configured validation, publication, and merge authorization.
Delivery requires current fixed-revision validation and review, remote checks, matching
head/base evidence, and settled queued feedback (`src/server/engine.ts`; ADRs 0003 and 0009).
