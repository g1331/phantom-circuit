# A client-first interface: brief, work and receipts

Status: accepted; implements the interface half of ADR 0013's first slice.

The interface was organized around the host's internals. Its four tabs were the PM conversation, the team, a seven-column stage board and a run log. Project facts sat in a modal, and task details sat in another. A finished Project showed six empty columns, the team view was a stream of "Review started / Review completed", and nothing said what had been delivered or what was waiting on the user. Surveyed agent products (Codex, Devin, Cursor, Copilot Agent HQ, Jules, Factory, Conductor, t3code, Linear, Antigravity) share the same shape: a list of sessions for the user to supervise. Phantom's user is the client of an autonomous team, so the interface starts from what they asked for, what was delivered, and what needs them.

The product is now built from addressable pages. Hash routes make every page linkable, so the browser's back button and a phone link work:

- **Project home.** A centered liaison conversation with a compact composer. Engineering activity starts collapsed, with the current phase and elapsed time still visible. The brief has its own navigation entry at every screen width, so the conversation keeps the main reading space. The brief answers three questions in order:
  - what needs you: open questions and explicit user decisions with a reply or decision entry;
  - what is in progress, with each piece of work's step, owner and rework round against the three-round limit;
  - what was delivered since you last looked, with the preview and feedback actions next to it.
- **Work.** Every piece of work grouped by the user's attention instead of by host stage: needs you, in progress, paused by you, queued, delivered, cancelled. Internal holds stay with team progress and distinguish running diagnosis, queued automatic recovery and blocked work, with the team responsible and its next step visible. Raw diagnostics remain in task details. In the conversation, internal incident controls and interrupted-run recovery are folded away; explicit decisions and clarification answers remain directly available. The stage board is gone.
- **Addressable work detail.** On a wide screen the work list stays beside the selected task. On a phone the task occupies the content area. Direct links and browser history use the same task routes. The detail opens with a plain-language status, the controls and three addressable sections:
  - **overview:** the **receipt** (the acceptance criteria, the host's validation at the pinned revision, the independent review verdict with its model, and the merge), then the owner conversation and scheduling;
  - **specification:** what was asked, each feedback round and the document changes, long text clamped to a screen until opened;
  - **process:** the usage summary, one line per model run and one line per host event, with commands behind their own switch.
- **Team.** A roster rather than a log: the liaison and each active member, with their work and state. Each member's history is condensed to one line per finished turn, with its outcome and duration.
- **Project.** One page instead of a modal, in three sections: an overview (repositories, capacity and claim order, allowance, recent activity), the domain documents one line each, and the run log for diagnosis.
- **Settings.** The global runtime settings and the project's model settings stay dialogs: they are occasional configuration, not a place where the user works.

The desktop sidebar prioritizes conversation and work, followed by brief, team and project. On a phone the same five entries sit in a raised bottom bar. The brief and the receipts are designed for 390 px first. Project switching, language, theme and settings remain available in the navigation drawer.

The liaison conversation reads message and activity entries in stable pages of at most 50.
The client retains at most 150 entries and mounts at most 150 message components. Scrolling
restores discarded records from the host without changing the stored history or model context.
The turn directory describes the loaded window. Background state reads omit conversation
bodies. Earlier-page failures retain the current window and draft for an inline retry.

Project-level questions appear in the Work page's needs-you group even before a task exists.
The Work and brief links address the question's conversation form and focus that form when
opened, so a long conversation does not hide the requested answer above its latest messages.

Delivery previews are result links beside completed work. Everyday pages and repository
settings omit environment start, stop, port and process controls. Removing these controls
leaves existing services, commands and configuration intact; the team's existing preview
API remains available. When launched, a preview records its checkout revision and completed
task heads whose remote-confirmed merge commits are ancestors of that revision. The merge
commit is bound to the reviewed head, including squash merges; direct head ancestry is also
accepted when no merge commit was recorded. A delivery link requires the same project,
repository and fixed task head, a running preview and its recorded HTTP address. Missing
legacy or merge-revision evidence omits the link. The application's own origin is
excluded. Feedback and historical records remain available with or without a preview.

Rejected:

- **A session-centred home like the surveyed products.** It turns the client into an operator.
- **Keeping the stage board as an option.** It duplicates the grouped list and exposes host stages the user never acts on.
- **A routing dependency.** Six pages and their sections do not need one.
- **One long page per task or project.** With a real history (157 events, 24 runs, three rework rounds of full test output) the decision-relevant receipt was buried under screens of logs.
