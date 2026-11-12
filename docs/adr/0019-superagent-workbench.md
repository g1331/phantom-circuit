# An event-driven development team with a visual workbench

Status: M1 and M2 implemented and accepted through the real-platform loops below, after
independent implementation review. M3 and M4 remain planned. Existing installations require
an explicit update; source integration does not change a running service.

The user wants Phantom Circuit to adopt the organizing principles of
[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype/tree/8c32a9dc5d72c033816c6a8110b37f40cf94fba4),
with a visual primary interface showing incoming platform feedback, the team's judgments,
observable agent work, and results returned to their sources. Chat remains available as a
secondary requirements and discussion channel. This supersedes ADR 0013's remaining delivery
order and ADR 0014's conversation-first home when the corresponding milestones land.

## Reference and retained choices

The reference is the published prototype at revision
`8c32a9dc5d72c033816c6a8110b37f40cf94fba4`. Its README identifies it as a research prototype,
different from the article and internal system. Its code and documentation inform this direction;
they do not establish production readiness.

The adopted principles are:

- Minimize human attention and deliver usable results in the originating conversation.
- Separate a received event, its assessment, authorization to act, and its execution.
- Give existing work's follow-ups to its owner; additional context grants no new authority.
- Make proactive work depend on explicit written rules, with observation before automation.
- Persist input ownership, decisions, effects, and their outcomes across interruption.
- Show truthful states, including no-work judgments, unavailable assessment, and uncertain replies.

The primary references are the prototype's
[philosophy](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/000-philosophy.md),
[domain](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/001-domain.md),
[authorization](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/002-authorization.md),
[execution](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/003-execution.md),
and [panel](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/8c32a9dc5d72c033816c6a8110b37f40cf94fba4/docs/005-panel.md)
documents.

Phantom Circuit retains these deliberate differences:

- Intake coordination handles new requests, clarification, and cross-work routing. Each work has
  one persistent owner who decides technical methods and judges in-scope follow-ups. Temporary
  contributors are commissioned for bounded results rather than assigned permanent team seats.
- The host retains commits, validation, publication, and fixed-revision merge authorization under
  ADRs 0003 and 0009. Agent instructions and platform approvals do not replace those checks.
- Engineering failures first enter bounded internal diagnosis and recovery. Exhausted recovery
  stays visibly blocked or failed; a necessary product, access, or spending decision asks the user.
- The workbench keeps compact live work visible because the user explicitly wants it. Attention
  requiring a decision appears first. Routine activity produces no unsolicited progress messages.
- Completed receipts remain historical. Later implementation requires explicitly authorized linked
  new work, preserving ADR 0018 rather than reopening obsolete execution.
- Existing Task and team pauses keep their interruption behavior. A durable admission hold also
  prevents new work from starting while the team is paused. The work switch remains a claim gate.
- Harness credentials and target-repository working methods remain with their existing owners.
  This direction introduces no bundled engineering skills or default skill injection.

## Evolve the existing execution lifecycle

Extend Task, Run, native owner-session bindings, recovery, and the Operation ledger. Do not create
another work scheduler or migrate live Tasks into a parallel Ticket lifecycle. A separate kernel
would duplicate ownership of execution and recovery before delivering the requested experience.

The new boundary must retain these distinct facts:

- Immutable platform inputs: native identity and revision, source conversation, actor and bot
  facts, original evidence, source and observation times, URL, and reply destination.
- Input dispositions: admission or refusal, assessment outcome and reason, policy version,
  linked work, and delivery or hand-back to an owner. Inputs can exist without Tasks.
- Work authorization: the admitted request, authorizing actor, recorded scope, and policy basis.
  Repository onboarding and source-sender admission remain separate checks.
- Outbound intentions and receipts: frozen destination, purpose, payload, stable delivery identity,
  and queued, sent, uncertain, or unavailable outcome. Reuse Operation reconciliation.

The original external sender must remain distinguishable from a local user authorizing work.
Source text must not be disguised as a local user implementation Message. All creation, revision,
clarification, and recovery paths consult the same effective authorization contract.

Source reads retain pagination and cursor evidence. Failed or incomplete reads do not advance
past missing inputs or appear as an empty healthy inbox. Assessment serializes per source
conversation and commits only against the policy version it read. Compact, bounded read models
serve the workbench; large source bodies and histories load on demand.

## Milestones

Each milestone is a complete product increment with its required persistence, interface,
recovery, and verification. Infrastructure work belongs inside the increment that needs it.

### M1: One explicit GitHub request through to delivered result

Make the visual workbench primary and deliver a narrow real input-to-result loop. Start with
one configured authorized repository, explicitly permitted senders, and directly addressed Issue
requests for one independently deliverable Task. New source intake starts disabled until its
receiving scope, sender policy, and agent addressing identity are configured. Proactive work
remains off. Existing Web discussion and implementation continue to work.

This milestone includes durable intake, explicit-request admission, recorded scope, existing
execution, original-Issue result replies, duplicate and uncertain-write protection, and the
admission hold. Those mechanisms are prerequisites for exposing an active external source.

Bind the original Issue without publishing a duplicate or replacing its authored body. Keep
accepted evidence separate from later edits. A request needing several deliverables reaches
product scoping before execution; the first completed child cannot close the whole request.
Imported-Issue closure and settlement must be explicit, tested branches of the existing lifecycle.

The workbench shows received inputs, recorded decisions, current observable work, verification,
review, outcome, and reply state. It also represents refused, no-action, and unavailable inputs.
Existing Tasks remain readable from their actual records. M1 retained coordination assessment
for bound-PR feedback; M2 now sends that feedback directly to the recorded owner.
Broad incoming-PR intake and default-branch CI monitoring are later capabilities. Existing checks
remain visible as delivery evidence without pretending they were ingested source events.

#### Workbench layout

The desktop home is an automatically arranged relationship canvas. Source nodes link to their
recorded inputs and Tasks. A Task remains one work node across implementation, validation,
review, and repair. A coordination node appears only for an actual live coordination Run. New events update content
without sorting existing nodes by their latest activity. Zoom and reset change the view only.
On phones, decisions and work appear in a vertical layout with bottom navigation.

Selecting work opens an addressable side panel with recorded events, source and owner facts,
fixed-revision evidence, and the existing specification, process, and owner conversation.
Delivery and original-platform replies keep separate states. Chat stays in a compact, expandable
composer and a dedicated conversation page with its existing bounded reading contract.

Records combine paged retained inputs, judgments and replies with the project's event snapshot.
Commands and activity traces appear under the execution filter; they do not flood the default
view. Selecting an input or reply reads its retained full text on demand. A failed refresh
keeps previously loaded text visible and reports the read error separately from delivery state.
A record links to its original input or task process for the detailed evidence.
Sources combines receiving health with repository, sender, command, and cutoff controls.
Settings groups model execution, team instructions, repositories, documents, and run history.
Connected sources include Web requests, authorized GitHub Issues, and M2's repository-enabled
feedback from bound Issues, PRs, reviews, and CI. M3 proactive rules remain planned.

Acceptance:

1. A real explicitly admitted Issue in an authorized test repository reaches fixed-revision
   delivery and a confirmed original-Issue result reply without web copy/paste, duplicate Issue
   creation, or replacement of the source body.
2. Refused and no-action inputs stay inspectable without a Task; duplicate input, restart, and a
   lost reply response converge to one effective work/reply or an explicit unresolved hold, while
   team pause blocks new admissions across restart and preserves individual Task pauses.
3. Actual 390 px and 1280 px views show what needs the user, current work and source health, and
   one input's complete recorded history, with source links, reply state, and secondary chat.

M1 delivery evidence: real [Issue #93](https://github.com/g1331/phantom-circuit/issues/93)
produced one Task and [PR #95](https://github.com/g1331/phantom-circuit/pull/95), merged into
this repository's `feat/superagent-workbench` branch by an isolated acceptance instance.
Build, unit/integration,
type, and complete browser checks passed at `1bf7aa9d61a7a108854e75299dab761d7e34b49a`;
independent review approved that head and its fixed base. The original body remained unchanged,
and exactly one [result reply](https://github.com/g1331/phantom-circuit/issues/93#issuecomment-6798927187)
was confirmed. Repeated intake and recovery retained the same Task and original Issue.
The user's running service, data, and model choices were preserved.

The receiving cutoff follows body creation or latest edit time. Comments and other Issue activity
alone do not renew an older body request. A committed no-action judgment freezes its answer:
repetition is idempotent, and conflicting judgments, Task creation, or later clarification are
rejected. A subsequent model-run failure or interruption preserves that judgment and Run history;
automatic and manual recovery do not reassess it. Unresolved steering retains its reconciliation
hold. Correcting a final judgment requires a new explicitly authorized request.

### M2: Persistent owners, dynamic collaboration, and feedback

Each Task keeps one owner with its real native session, workspace, and recorded backend/profile.
Configuration changes apply to new ownership; explicit reassignment fences the previous owner.
The owner chooses a capability profile and a concrete objective when commissioning a contributor.
Each assignment records its requester, permission mode, private workspace, Run, result, and
integration outcome. The owner remains responsible for delivery and explicitly integrates code.
Read-only assistance, implementation contributions, and host-triggered independent checks are
bounded executions, without fixed PM/Dev/Review staffing. Existing stored role and profile keys
remain readable and retain their adapter permission meaning.

Contributions use Task-scoped records and existing Run capacity rather than a second workforce
scheduler. A delegated call returns its result to the owner; concurrent calls can execute within
available capacity. Interruption retains the workspace and native session for an explicit retry.
Cancellation stops the contributor, and old-owner results cannot change reassigned work.
Separate worktrees prevent accidental shared editing; they are not security sandboxes.

Extend the same workflow to originating Issue discussion, bound PR comments, inline reviews,
review decisions including bodyless approvals, and bound-PR CI changes. Keep owner/input binding
independent of an individual Run and fence it on reassignment. Deliver at a safe next work turn;
new mid-turn steering is not required for every backend.

An owner judges in-scope follow-ups, takes no action when appropriate, or hands them back with a
reason. Intake coordination handles new scope and cross-work routing after that hand-back. Explicit object links
can establish ownership; similarity and context-only following do not. Acknowledgment or delivery
alone does not prove the owner read or dispositioned an input. Ambiguous native delivery holds
for reconciliation. An unavailable owner history cannot silently become an empty new session.

The independent read-only owner conversation keeps its existing permission contract. Authorized
work follow-ups use the actual work-session path, not a writable version of that question fork.
Existing validation diagnosis, review, recovery, and merge gates continue to perform the work.

Repository feedback reception is opt-in and can be disabled locally while retaining received
records. Human repository owners, members, collaborators, and explicitly admitted sender IDs may
supply bound feedback; bot comments and host reply markers do not start feedback loops. CI inputs
are tied to the checked revision. Old-version CI stays historical after the work advances.
Original-platform result replies use the Operation ledger and verified native comment identity;
an uncertain response requires remote reconciliation before another write.

Acceptance:

1. A bound in-scope follow-up is judged in the actual owner's work session without routine PM
   re-triage; unrelated/context-only input acquires no authority, and wider scope returns for an
   explicit decision without changing the read-only owner question contract.
2. A newly ingested PR CI failure and actionable review lead to repair, fresh validation/review,
   fixed-version merge, and original-thread disposition without human engineering intervention.
3. Restart and reassignment preserve input order and fence late callbacks; pauses and necessary
   answer holds survive automatic feedback, and changed PR heads cannot reuse old merge evidence.
4. A real owner delegates a bounded contribution, receives and integrates its result, and delivers
   without a permanent collaborator seat or transferring its ownership to the contributor.

M2 delivery evidence:

- Real [Issue #102](https://github.com/g1331/phantom-circuit/issues/102) produced
  [PR #103](https://github.com/g1331/phantom-circuit/pull/103). The owner commissioned a
  read-only implementation inspection, used its findings, and resumed its original native
  session for a new PR review request. Fresh checks and independent review passed before merge.
  The [result reply](https://github.com/g1331/phantom-circuit/pull/103#issuecomment-6823790570)
  was confirmed on the original PR.
- Real [Issue #104](https://github.com/g1331/phantom-circuit/issues/104) produced
  [PR #106](https://github.com/g1331/phantom-circuit/pull/106). A required GitHub Actions check
  failed at `9f39136`. The ingested failure resumed the original owner's native session;
  the owner repaired the scoped document. Required checks and fresh independent review passed
  at `32ee1fa`, and the host merged that revision without human repair or override.
- Both loops ran in isolated instances and merged only into `acceptance/m2-owner-continuity`.
  The user's running service, original data, and selected models were preserved.
- The release passed 672 unit/integration tests with nine skipped tests, typechecking,
  build, browser checks at 1280 and 390 pixels, and independent implementation re-review.
  Focused regressions cover read-only OMP process permissions and retryable collaborator
  interruption. Browser filtering also verifies distinct input and judgment record identities.

### M3: Written-rule proactive maintenance

Add versioned off, observe, and auto modes for inferred candidates. Observe is the default for
new proactive configuration. Explicit admitted requests remain available in every mode. First
rules cover selected unaddressed Issues and default-branch CI failures. Bound-PR CI normally
continues its existing work rather than starting a competing maintenance Task.

Admission policy versions are separate from ADR 0016 team instructions. Each proactive assessment
records its evidence and judgments of the enabled rules. Self-generated events must not create a
maintenance loop. Conditions depending on elapsed time belong in sources, not waiting model turns.
Policy changes invalidate in-flight stale assessments. Interrupted execution revalidates its
recorded authority before continuation; changes never erase prior effects or lift user holds.

Acceptance:

1. Observe records a real candidate's evidence, rule judgments, proposed scope, and would-accept
   decision without execution or outward messages; off admits no inferred work, while explicit
   admitted requests continue in every mode.
2. Auto completes eligible Issue and default-branch repair scenarios through the established
   workflow and delivery gates; unmatched events and self-generated activity start no unauthorized
   or competing work.
3. Policy changes racing assessment, duplicate events, restart, and pause preserve one effective
   repair with its authorization history and prevent stale acceptance or silent release of holds.

### M4: Claude Code through shared host MCP tools

Expose the established host commands through scoped MCP and add Claude Code using its native CLI
authentication and real saved sessions. Earlier milestones use backend-neutral commands where
needed without waiting for MCP or forcing existing adapters through a new transport.

Tool capabilities bind the current role, Run, Task, repository, and authority. Settings changes
apply to future bindings. Existing work keeps its recorded backend/profile until an explicit
handoff fences the old owner. Missing history and unsupported capabilities fail explicitly.

Acceptance:

1. Claude Code completes the same real authorized GitHub request through fixed-revision delivery
   and an original-thread reply without copying harness credentials into Phantom Circuit.
2. Restart continues its actual saved session and reconciles pending input/effects; missing history
   stays unavailable, and settings changes cannot silently transfer already-owned work.
3. MCP and existing adapters enforce equivalent repository, scope, pause, and fixed-head checks,
   including fencing after reassignment and the separate read-only owner conversation contract.

## Workbench and communication

A work trajectory follows actual source-to-outcome causality. It can branch, wait, receive later
feedback, or end without work. Empty fixed PM/Dev/Review columns and timer-generated activity
would misrepresent that causality. Use observed actions and last activity time; reserve motion for
actual changes. Preserve adjustment, verification, and team-investigation meanings already defined
by the existing interface.

An input may be awaiting assessment, refused by admission, judged no action, delivered as context,
or unavailable for judgment. These are separate from Task execution states. Source health is also
separate: a failed read is neither no action nor proof that no new input exists. Engineering
completion and result-message delivery remain separately visible.

Keep existing work details, receipts, task addresses, conversation drafts, history paging, and
browser navigation. On desktop the primary area is the visual workbench with details on demand;
on mobile use an ordered trajectory with reachable actions. Chat and requirements submission stay
available without occupying the primary work area.

A direct user question receives a direct answer. Unsolicited messages require a usable result, a
concrete necessary decision/resource, or a definitive inability to complete. Routine progress,
waiting checks, recovery attempts, and unfinished PRs remain internal and inspectable.

## Migration and release evidence

Preserve Task IDs, original user Messages, backend/profile and owner Run bindings, worktrees,
pause provenance, recovery links, Operation attempts, fixed-version tests/reviews, and external
completion evidence. Historical source admission and replies that were never recorded remain
not recorded. Backfill must not send messages, re-evaluate work, resume execution, or call models.

Existing feedback collection remains the sole writer until an explicit cutover makes the new
path authoritative. Legacy dedup Operations do not reconstruct absent native inputs or decisions.
Each source is enabled through explicit configuration, not inferred from repository write access.

Implementation tests use the existing Store/HTTP/GitHub/backend/Engine/browser seams and real
temporary Git repositories. Product acceptance additionally requires the authorized real-platform
loop and actual screenshots named above. Credentials, repository creation, deployment, and paid
model execution require their existing authorization; missing authorization is a concrete release
blocker, not permission to fabricate successful integration evidence.

Electron, additional messaging platforms, and remote multi-team access follow these milestones.
Each delivered increment updates this record's implementation status and affected older ADRs.
