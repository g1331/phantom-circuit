# Phantom Circuit

A local software-engineering orchestrator where the user discusses product requirements with a project PM and evaluates delivered experiences.

## Language

**Project**: A product context managed by one PM and associated with one or more repositories.
_Avoid_: Repository, workspace

**PM**: The agent responsible for a project's requirements, technical decisions, coordination and acceptance.
_Avoid_: Dispatcher, coding worker

**Dev**: An agent assigned to implement and revise one task in its own branch and worktree.
_Avoid_: PM, reviewer

**Task**: An independently verifiable slice of an explicit implementation request, with acceptance criteria and blocking dependencies.
_Avoid_: Run, conversation

**On-call**: Historical role for diagnosing a failed host validation. The Task's Dev now does this in its own thread and settles it as a retry, a fix, a trunk resync or a question for the user.
_Avoid_: PM, Dev

**Owner conversation**: The user's direct exchange with the Dev who owns an unfinished Task. The owner answers read-only; a change of direction goes to the PM before anything changes, and the PM's conversation records a summary of each exchange.
_Avoid_: Dev chat, steer

**Reassign**: Handing an unfinished Task to a fresh Dev. The worktree and branch stay; the previous Dev's conversation does not, and the rework budget restarts.
_Avoid_: retry, restart

**Brief**: The user's summary beside the conversation: what needs them, what is in progress, and what was delivered since they last looked.
_Avoid_: dashboard, feed

**Receipt**: A Task's delivery record as the user reads it: acceptance, host validation at the pinned head, the independent review verdict with its model, and the merge.
_Avoid_: report, evidence log

**Run**: One bounded execution of a PM, Dev, Review or On-call role.
_Avoid_: Task

**Work switch**: The repository's permission to claim new tasks; existing task lifecycles continue when it is closed.
_Avoid_: Kill switch, pause

**Engineering completion**: Confirmed merge of work satisfying the task's verification and review requirements.
_Avoid_: User acceptance, turn completion

**Experience feedback**: A user's observations of delivered behavior, used to initiate a related improvement or repair.
_Avoid_: Code review

**Provider**: An authenticated model upstream available to Phantom Circuit, either through the existing Codex login or a saved custom connection.
_Avoid_: Model, profile

**Project model profile**: A role's Provider, model and reasoning effort, either following the global assignment or pinned by its Project.
_Avoid_: Agent backend, Provider

**PM activity**: A durable, user-visible record of why the PM started acting and which observable step it is performing.
_Avoid_: Hidden chain of thought, raw log

**Incident**: A durable, actionable record of an unexpected Run or delivery failure that requires Dev or PM assessment, or user-visible escalation.
_Avoid_: Event, Review finding

**Clarification**: A request for the user to supply a necessary external fact, access decision or product choice, raised by the PM before Task publication or revision, or by a Review of an affected Task.
_Avoid_: Technical question, confirmation

**Agent backend**: The execution system that hosts a Project's PM, Dev and Review sessions.
_Avoid_: Model, Provider

**Run usage**: Resource consumption attributable to one Run, including reported tokens and elapsed execution time.
_Avoid_: Account allowance, bill

**Account allowance**: The upstream account's reported capacity and reset windows, independent of any individual Task.
_Avoid_: Run usage, cost estimate

**Cost estimate**: A monetary estimate based on reported Run usage and the prices fixed when the Run began.
_Avoid_: Invoice, amount charged

**Recovery item**: A durable record of interrupted work and the successor Run that continues its last verified phase.
_Avoid_: Retry, new Task
