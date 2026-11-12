# Phantom Circuit

A local software-engineering team whose workbench shows requests, decisions, ongoing work and delivery.

## Language

**Project**: A product context with shared coordination and one or more repositories.
_Avoid_: Repository, workspace

**Coordinator**: The execution that judges new requests and handles product clarification or cross-work routing. Historical records call this PM.
_Avoid_: Work owner, merge approver

**Owner**: The agent continuously responsible for one Task, including implementation, feedback, verification, and delivery. Historical records call this Dev.
_Avoid_: Temporary contributor, coordinator

**Collaboration**: A bounded contribution commissioned by an owner, with a concrete objective, permitted actions, and a result returned to that owner.
_Avoid_: Permanent role, ownership transfer

**Follow-up**: A source-linked input belonging to existing work, retained with its revision, judgment, and reply outcome.
_Avoid_: New authorization, read-only question

**Task**: An independently verifiable slice of an explicit implementation request, with acceptance criteria and blocking dependencies.
_Avoid_: Run, conversation

**On-call**: Historical role for diagnosing a failed host validation. The Task's Dev now does this in its own thread and settles it as a retry, a fix, a trunk resync or a question for the user.
_Avoid_: PM, Dev

**Owner conversation**: A direct question to a Task's owner in an independent read-only branch of its saved work session. An explicit request to act enters the work's follow-ups separately.
_Avoid_: Dev chat, steer

**Reassign**: Handing an unfinished Task to a fresh Dev. The worktree and branch stay; the previous Dev's conversation does not, and the rework budget restarts.
_Avoid_: retry, restart

**Brief**: The user's summary of what needs them, what is in progress, and what was delivered since they last looked.
_Avoid_: dashboard, feed

**Receipt**: A Task's delivery record as the user reads it: acceptance, recorded validation and review at their fixed versions, the merge, and the delivery source.
_Avoid_: report, evidence log

**Run**: One bounded execution for coordination, ownership, a temporary contribution, or an independent check.
_Avoid_: Task

**Work switch**: The repository's permission to claim new tasks; existing task lifecycles continue when it is closed.
_Avoid_: Kill switch, pause

**Engineering completion**: Confirmed merge of work satisfying the task's verification and review requirements.
_Avoid_: User acceptance, turn completion

**External delivery**: A Task completed outside Phantom Circuit, with its linked merged work and any associated Issue completion verified.
_Avoid_: Phantom Circuit validation, reassign

**Experience feedback**: A user's observations of delivered behavior, used to initiate a related improvement or repair.
_Avoid_: Code review

**Provider**: An authenticated model upstream available to Phantom Circuit, either through the existing Codex login or a saved custom connection.
_Avoid_: Model, profile

**Project model profile**: A capability's Provider, model and reasoning effort, either following the global assignment or pinned by its Project.
_Avoid_: Agent backend, Provider

**PM activity**: A durable, user-visible record of why the PM started acting and which observable step it is performing.
_Avoid_: Hidden chain of thought, raw log

**Incident**: A durable, actionable record of an unexpected Run or delivery failure that requires Dev or PM assessment, or user-visible escalation.
_Avoid_: Event, Review finding

**Clarification**: A request for the user to supply a necessary external fact, access decision or product choice, raised by the PM before Task publication or revision, or by a Review of an affected Task.
_Avoid_: Technical question, confirmation

**Agent backend**: The execution system that hosts coordination, owner, contributor, and independent-check sessions.
_Avoid_: Model, Provider

**Run usage**: Resource consumption attributable to one Run, including reported tokens and elapsed execution time.
_Avoid_: Account allowance, bill

**Account allowance**: The upstream account's reported capacity and reset windows, independent of any individual Task.
_Avoid_: Run usage, cost estimate

**Cost estimate**: A monetary estimate based on reported Run usage and the prices fixed when the Run began.
_Avoid_: Invoice, amount charged

**Recovery item**: A durable record of interrupted work and the successor Run that continues its last verified phase.
_Avoid_: Retry, new Task

**Installed release**: A fixed version of the team software that runs independently of a development checkout.
_Avoid_: Workspace, Project, development server

**Team instructions**: A Project’s versioned working agreements for repository conventions, engineering practices and delivery requirements. Each Run uses the version saved when it starts. Its repository conventions section holds one block per repository that the team reads from the trunk (commit style, pull request and Issue templates, CI, verification commands, agent instruction files); the rest of the text is the user's.
_Avoid_: Permissions, role configuration, memory bank

## Super-agent workflow language

**Input**: An immutable event received from a platform or the Web conversation, retaining its origin and evidence independently of whether it produces work.
_Avoid_: Task, authorization, Run

**Admission**: The deterministic decision that a source event is eligible for assessment under the configured receiving scope and sender policy.
_Avoid_: Assessment, repository write permission

**Work authorization**: The recorded request or rule and scope that permit a piece of work, including who or what authorized it.
_Avoid_: Context, team instructions, repository onboarding

**Source reply**: A purpose-bound response returned to the conversation where a request originated, with its own delivery outcome.
_Avoid_: Merge, local notification, acknowledgment of completion

**Workbench**: The visual account of received inputs, recorded judgments, observable work, and delivered results.
_Avoid_: Fixed stage board, raw event log
