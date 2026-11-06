# Keep installed releases separate from development

Status: accepted. Extends ADRs 0010 and 0013.

The team must continue working after its terminal closes, without running code that changes underneath an active delivery. Persistent home-directory state alone does not provide this separation. The previous launcher executed backend source and resolved prompts, skills, and browser assets against the current working directory.

A Linux user service runs a versioned release beneath the selected `.phantom` data root. Each release contains its own source, built browser assets, prompts, pinned skills, and locked production dependencies. Runtime assets resolve relative to the installed module, not the caller's directory. Repositories and mutable execution state remain outside the release. The service runs as the account that owns the existing Agent and GitHub authentication.

The release keeps the existing TypeScript execution path and includes `tsx` as a production dependency. Emitting backend JavaScript would add a second runtime layout and compiler pipeline without removing the Node or external-tool requirements. A release snapshot provides checkout independence without that additional path.

Staging completes before the selected release changes. Installation neither starts the Engine nor enables boot startup. A running service must be stopped before an upgrade. systemd owns restart supervision and descendant cleanup. The host still owns task authorization, pinned verification, and merge decisions. Lingering and unattended credential availability remain explicit machine-administration choices.

Service interruptions are not user pauses. Recovery must continue a successor that was itself interrupted, preserving one successor per interrupted Run and respecting explicit user pauses. The browser renews its local session and refreshes state after reconnection rather than replaying mutations.

Windows keeps its existing foreground and development launchers. Linux service support does not introduce public network listening, a desktop installer, automatic updates, or database rollback.
