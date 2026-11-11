# Complete externally delivered work with explicit provenance

Accepted. A customer can finish work outside Phantom Circuit. Once the host verifies the linked remote delivery, the Task completes with an external source and releases its dependencies. Requiring another Phantom Circuit development and review cycle would repeat work the customer already completed.

The host checks the authorized repository, linked merged PR, fixed remote head and merge commit, target branch, completed Issue, and the relationships between those objects. If another merged PR closed the Issue, its identity and version remain part of the evidence. The external head can differ from the original local checkpoint. Both versions remain recorded. Incomplete or failed remote reads keep the original development on hold until the evidence is available.

External completion has its own provenance. Existing tests, reviews, approval, pause events, and work history retain their original revisions and sources. The interface distinguishes the external merge from the validation and review actually recorded locally. Phantom Circuit's own merge authorization continues to require the fixed-revision evidence in ADR 0009.

The host stops any remaining development or review for the old Task before settlement. Settlement preserves the original worktree and owner history, supersedes obsolete engineering waits and recovery attempts, and prevents a late callback or restart from resuming the old work. Repeated synchronization produces one settlement and one delivery notification. Feedback remains attached to the Task and follows the normal product conversation.

Only explicitly superseded Incidents become historical. New Incidents remain visible and can record decisions without changing the original Task's control state or delivery checkpoint. New implementation follows an explicitly authorized feedback request as separate work.

Delivery links and running-version claims use the recorded external revision and the existing runtime evidence rules. An external merge alone supplies no preview or installed-version proof. External settlement makes local state consistent with the verified remote result without changing remote acceptance text or starting a model retrospective.
