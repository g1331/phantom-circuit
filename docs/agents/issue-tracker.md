# Issue tracker

Target projects use GitHub Issues, Projects and repository Milestones. The host exposes scoped tools and performs mutations through `src/server/github.ts`; agents must not bypass that broker using `gh`, network calls or other connectors. Onboarding authorization permits those engineering operations for that repository, excluding production deployment. External PR triage is off by default.

This source checkout has no remote configured at initial delivery. Keep local implementation and tests here; do not infer authorization to create or push a GitHub repository. Specifications follow the approved plan and task context until a remote tracker is explicitly connected.
