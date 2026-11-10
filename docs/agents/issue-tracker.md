# Issue tracker

Target projects use GitHub Issues, Projects and repository Milestones. The host exposes scoped tools and performs mutations through `src/server/github.ts`; agents must not bypass that broker using `gh`, network calls or other connectors. Onboarding authorization permits those engineering operations for that repository, excluding production deployment. External PR triage is off by default.

For a retained Task blocked by an uncertain `create-issue`, the Project PM calls the host tool
`reconcile_task_issue` with `{ "taskId": "<original task id>" }`. Keep the original Task and all
requirements. The result reports `adopt` with the original Issue, `authorize` with evidence for
one controlled creation, `blocked` with the internal reason, or `none` when this recovery does
not apply; `resumed` says whether the original phase was released. Adoption and authorized
creation finish through normal host publication and scheduling. Repeated calls reuse the same
outstanding authorization. A user pause must be released through its original user control;
the PM tool preserves it. For `blocked`, retain the operation and use the existing Incident
coordination with that reason. Never delete an operation, rebuild the Task, edit production
SQLite or create an Issue outside the host to get past this guard.

The currently blocked queued-message Task can use this same entry after the running host has
been updated to a release containing the fix. Source integration alone leaves an older running
host unchanged. Follow the normal stop/update/start procedure for that deployment, retaining
its data root and workspaces; Linux installed releases follow
[the service upgrade procedure](../linux-service.md#upgrade-without-changing-the-development-checkout).
Then use the original Task id
with the tool above. `adopt` reuses its remote Issue; `authorize` permits the next host cycle to
create it once; `blocked` keeps the specific engineering failure with the PM.

This source checkout has no remote configured at initial delivery. Keep local implementation and tests here; do not infer authorization to create or push a GitHub repository. Specifications follow the approved plan and task context until a remote tracker is explicitly connected.
