# Keep execution state local and engineering records on GitHub

Phantom Circuit runs as a single local service with durable SQLite execution state; GitHub stores requirements, project progress and PR delivery. An Issue stage cannot represent process lifecycle or authorize a task claim, so the host separately records implementation intent, repository authorization, switches and runs. This avoids requiring public webhook infrastructure for the Windows MVP while making recovery reconciliation necessary.

Amended by ADRs 0013 and 0016: local Tasks retain requirements and progress independently of
Issue registration. Explicit no-Issue agreements produce PR delivery with requirements and
acceptance in the PR body. Unspecified agreements retain the existing Issue registration flow.
