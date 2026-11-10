# Keep host enforcement separate from engineering methods

Accepted. The original pinned-skill decision was superseded on 2026-11-10 to restore low-intrusion orchestration.

Role instructions provide responsibilities, task context, host tools, permissions and delivery contracts. Engineering methods follow the target repository's conventions and explicitly adopted team instructions. The host no longer distributes an engineering skill library, adds a default skill catalog or inlines a conflict-resolution method. Moving the library to another directory would retain the same behavioral intervention, so the runtime dependency and installer are removed together.

The PM acts as the delegated technical decision-maker, while the host enforces claims, limits and external mutations; prompt text alone cannot enforce concurrency or grant authorization. A worktree isolates code changes but is not a security boundary against malicious programs running as the same OS user.
