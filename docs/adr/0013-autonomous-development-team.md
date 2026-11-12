# Operate as an autonomous development team behind a requirements conversation

Direction update: ADR 0019 M1 delivers the visual primary workbench and opt-in, explicitly
addressed GitHub Issue requests through original-Issue result replies. The user remains the team's
client. Owner-led platform follow-ups and proactive maintenance remain later milestones.

Status: accepted direction, partly implemented: these parts have landed:

- the Dev handling its own failed host validation, amending ADR 0005;
- the team view with a team-wide pause;
- direct owner conversations: each question forks the owner's saved work session natively into an independent read-only conversation, with direction changes going through the liaison;
- handing a piece of work to a fresh Dev;
- the page-based interface of ADR 0014. Until each remaining slice lands, ADRs 0001, 0005, 0008 and 0009 describe the host's actual behavior, and agents follow them rather than this record.
- independent installed releases and Linux user-service operation, described in ADR 0015. Desktop packaging and application-level remote authentication remain unimplemented.
- reading and following repository conventions for commits and pull requests, described below. Choosing between direct pushes and pull requests per repository is not implemented; delivery still follows ADR 0003.
- optional Issue registration following explicit adopted agreements or a user request, with
  decision provenance retained on each Task under ADR 0016. Local Tasks without Issues use the
  same owner, collaboration, validation, independent review, host PR merge and source delivery.
  Their PR bodies retain the requirements and acceptance criteria; Issue references and closure
  directives are present only when the Task has an Issue. Existing Issue intake remains separate.
  After a requirement revision, PR publication refreshes only the marked host requirements
  section and preserves surrounding authored content. The existing operation ledger reconciles
  a lost update response before repeating a write.

Phantom Circuit is a development team and the user is its client. The user discusses requirements and evaluates delivered behavior; planning, branches, commits, pull requests, reviews, CI, role assignment and model choice are the team's own business and are not part of the user's interface. On 2026-11-03 the operator standing in for the user intervened fourteen times across three Tasks (seven messages, seven host or test fixes), and none of those interventions was a product decision. Each one was an engineering problem — missing evidence, a flaky check, a port collision, machine load, a base resync — that the team escalated instead of resolving.

The team escalates only product choices, authorization (access, writes beyond what onboarding granted, irreversible or outward-facing actions) and spending. It diagnoses and fixes engineering failures internally, by giving the member who owns the work host authority to investigate before anything reaches the user. Under ADR 0005, unexpected failures always go to PM assessment; that path now becomes the fallback rather than the default route to the user. When the team does ask, it asks in product terms, without head/base, retry or Incident vocabulary.

Roles are the team's own arrangement. The user never has to configure roles or per-role models; the team assigns work by what its members can do. Hiding roles from the user's interface is not the goal, though, and neither is cutting the user off from the team. By default the user talks to one liaison and sees progress in plain language. A team view shows what the team and each member are doing right now, as summaries first, with records, diffs and pull requests available on demand. The user can also talk directly with the member who owns a piece of work; the liaison receives a summary of that conversation, and the owner aligns with the liaison before changing direction. Intervention stays available but out of the way: pausing, resuming or stopping a piece of work or the whole team, redirecting, reassigning, taking a piece of work over, and rolling back a delivery. The team surfaces the relevant control when it detects trouble. Autonomy is the default mode, not the only one. Inside the team one owner carries a Task from plan to delivery. Independent review by a different model stays, scaled by risk; ADR 0009 remains the policy until a later decision replaces it. Relays between roles are removed where they lost information, such as Dev handoffs that never reached the review and PM restatements of technical diagnoses.

The team works the way the repository already works. When it takes over a repository it learns that repository's conventions and follows them:

- direct pushes to the trunk or pull requests;
- branch and commit style;
- templates, CI and agent instruction files;
- whether the project uses Issues, and how.

The host reads the conventions read-only from the trunk when a repository is onboarded and again when the user asks on the Project page: agent instruction files, contributing guides, pull request and Issue templates, CI workflow commands, package verification scripts (including namespaced verification entries), and the style of the last 30 commits (gitmoji or Conventional Commits when at least 60% of them follow it). One separate, read-only PM turn interprets the actual tracked file contents and up to ten recent closed PR titles/bodies. Evidence is bounded and clipped text is marked; it has no host tools, cannot execute discovered commands, does not resume the liaison conversation and is not automatically retried after interruption. The result is one `#### owner/name` block in ADR 0016's repository conventions, saved with the team as source; reading again replaces only that block, rejects concurrent edits and leaves the text untouched when no conventions exist. When the Run's repository conventions are non-empty, the Dev ends its report with a commit message and pull request body written to them; the host commits with that message, titles the pull request with its subject, and keeps its own task marker and any associated Issue link in the body. Without conventions, or without that block, the host's fixed format is the default. Direct-push-vs-PR delivery flow is unchanged. To an outside reader its changes should look like the existing team's. The only GitHub records it leaves are the ones those conventions produce; Phantom's own ledger stays in local state, which narrows ADR 0001's GitHub record-keeping to what the repository already uses. Where the team judges a practice can be improved, it proposes the change or makes it as ordinary delivered work and reports it to the user; learning does not silently invent new practices. Repository onboarding authorization and branch protection still bound what it may write.

Team members are existing agent harnesses, used without intrusion. Phantom launches the harness the user already has installed, with its existing authentication: a subscription login stays a subscription and an API key stays an API key, and Phantom stores no harness credentials. Claude Code is the next harness, used directly through its CLI. Host tools move behind a host-run MCP server, so any MCP-capable harness can join through the same tools; this generalizes ADR 0008's backend interface.

Remote use means one person reaching their own computer or server from elsewhere, in the way t3code does. The service holds GitHub write access and model credentials, so it requires real authentication before it listens beyond loopback.

The product ships as one core service in two packages. The desktop application is the main entry: an installer, a tray presence, launch at login and automatic updates, built with Electron because the service is already Node, and it keeps working after its window closes. On a server the same service runs headless and installs as a system service, so nothing has to keep a terminal open. The desktop application also connects to teams running on other machines and switches between them, and a phone reaches them through the web interface. The installed release runs separately from any checkout it develops: the team never runs its own unreleased code, and an upgrade is an explicit step. Server use makes Linux a supported platform alongside Windows, so the Windows-only process cleanup, credential-file permissions and shell invocation become platform adapters.

Direction under discussion, not decided: one deployment of the service is one team, and its members are combinations of harness, account and machine that the user makes available, possibly spanning several machines. Several people sharing one deployment is a later question.

The redesign is led by the operator rather than by Phantom itself, because it changes how the team organizes its own work; Phantom receives well-bounded slices once the skeleton exists. The original delivery order, superseded by ADR 0019, was:

1. team autonomy and a rebuilt interface (conversation, team view, direct owner conversations, intervention);
2. the service form: separation from the checkout, background and system service, Linux support;
3. learning and following repository conventions; the working-agreement memory portion is superseded by ADR 0016 (versioned project team instructions);
4. MCP host tools and the Claude Code harness;
5. the desktop application and remote access to several teams.

Each slice that lands updates the ADRs it supersedes and `CONTEXT.md`.

Owner conversations fix their backend, Provider, model and effort from the real work Run, not the Project's current settings. The Task retains its owner source separately from the scheduler's resume binding; reassignment clears both. Each question sees the work history already saved at fork time, subject to the harness's compaction and interrupted-tail handling. An in-flight operation is not evidence of completion. The owner fork never resumes, steers or writes the source session. Missing history fails the question without substituting a handoff summary, pausing development or creating recovery work. Structured answers carry a short summary to the liaison; a direction change first carries the user's original words and the owner's judgment through the PM queue, then returns a final answer on the same fork.

Codex uses a persistent read-only fork with goal continuation deferred, rejects all inherited host tools, and clears and verifies only the child goal before any owner turn. Codex retains its own native storage and login, while Phantom records the fork reference without moving user caches or copying credentials. OMP starts a separate process directly with `--fork`, disables discovery sources and executable tools, and verifies the effective owner instructions and exact `read,grep,glob` tool set. OMP forks stay in the managed session directory. These process and tool restrictions are not an OS security sandbox.
