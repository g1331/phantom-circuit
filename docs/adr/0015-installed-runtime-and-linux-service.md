# Keep installed releases separate from development

Status: accepted. Extends ADRs 0010 and 0013.

The team must continue working after its terminal closes, without running code that changes underneath an active delivery. Persistent home-directory state alone does not provide this separation. The previous launcher executed backend source and resolved prompts, skills, and browser assets against the current working directory.

A Linux user service runs a versioned release beneath the selected `.phantom` data root. Each release contains its own source, built browser assets, role prompts and locked production dependencies. Runtime assets resolve relative to the installed module, not the caller's directory. Repositories and mutable execution state remain outside the release. The service runs as the account that owns the existing Agent and GitHub authentication. The former bundled skill assets were removed under ADR 0002.

The release keeps the existing TypeScript execution path and includes `tsx` as a production dependency. Emitting backend JavaScript would add a second runtime layout and compiler pipeline without removing the Node or external-tool requirements. A release snapshot provides checkout independence without that additional path.

Staging completes before the selected release changes. Installation neither starts the Engine nor enables boot startup. A running service must be stopped before an upgrade. systemd owns restart supervision and descendant cleanup. The host still owns task authorization, pinned verification, and merge decisions. Lingering and unattended credential availability remain explicit machine-administration choices.

Service interruptions are not user pauses. Recovery must continue a successor that was itself interrupted, preserving one successor per interrupted Run and respecting explicit user pauses. The browser renews its local session and refreshes state after reconnection rather than replaying mutations.

Windows keeps its existing foreground and development launchers. Linux service support does not introduce public network listening, a desktop installer, automatic updates, or database rollback.

Delivery notices capture runtime identity once when the Engine starts. An installed runtime
uses its release manifest's canonical source path and clean commit. A checkout keeps update
inclusion unknown because its Git HEAD does not identify the ignored browser build. A later
source change leaves a captured release identity unchanged. The remote-confirmed merge
commit is bound to the reviewed task head so squash deliveries can be compared with the
running revision. Missing, dirty or unavailable evidence keeps update inclusion unknown.
Other repository deliveries carry no application-update notice. The notice and its evidence
remain attached to the original delivery message; synchronization never rewrites old messages.

A pending self-update offers service commands only when the running Linux process, data
directory, release layout and owned systemd unit identify the existing service, and its source
still exposes the service CLI. The source must first be updated to the delivered revision.
These instructions require an explicit user action. Generating a notice never stages a release,
changes the selected release, stops a process or restarts the host.
