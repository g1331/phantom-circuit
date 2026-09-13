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

**Run**: One bounded execution of a PM, Dev or Review role.
_Avoid_: Task

**Work switch**: The repository's permission to claim new tasks; existing task lifecycles continue when it is closed.
_Avoid_: Kill switch, pause

**Engineering completion**: Confirmed merge of work satisfying the task's verification and review requirements.
_Avoid_: User acceptance, turn completion

**Experience feedback**: A user's observations of delivered behavior, used to initiate a related improvement or repair.
_Avoid_: Code review

**Provider**: An authenticated model upstream available to Phantom Circuit, either through the existing Codex login or a saved custom connection.
_Avoid_: Model, profile

**Project model profile**: A Project-owned assignment from each PM, Dev or Review role to a Provider, model and reasoning effort.
_Avoid_: Global defaults, Provider

**PM activity**: A durable, user-visible record of why the PM started acting and which observable step it is performing.
_Avoid_: Hidden chain of thought, raw log

**Incident**: A durable, actionable record of an unexpected Run or delivery failure that requires PM assessment or user-visible escalation.
_Avoid_: Event, Review finding

**Clarification**: An unresolved product decision that the PM has explicitly asked the user to settle before affected Tasks are published or revised.
_Avoid_: Technical question, confirmation
