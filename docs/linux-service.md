# Run Phantom Circuit as a Linux service

Use the same Linux account that owns your GitHub and Agent logins. Install Node.js 24+, Git, GitHub CLI, and your chosen Agent before installing the service. The installer reuses those tools and does not configure credentials.

## Install an independent release

From the checkout containing the version you want to run:

```sh
npm run service -- install
```

Installation builds a separate release beneath `~/.phantom/.service/phantom-circuit/`, installs its own locked dependencies, and registers `phantom-circuit.service` with the user systemd manager. It does not start the team or enable startup at login. Your projects, authorizations, worktrees, and database remain in `~/.phantom`.

The installer does not import checkout-local databases. If an older installation still uses the checkout's `.phantom`, first start that version normally to complete the [home-state migration](../README.md#state-and-recovery), then stop it before installing the service. Preserve legacy workspaces referenced by its migration record.

To use a separate instance, pass an absolute `--data-dir` and a distinct `--name` to every service command. Keep the directory under a `.phantom` directory. Set its port in that directory's `config.json` before starting if port 4317 is already in use:

```json
{ "port": 4318 }
```

Do not run a development server against the installed instance's data directory. Use `npm run dev -- --data-dir=.phantom/dev` for development.

## Start and inspect the team

Starting an existing instance can automatically continue authorized work and use its configured models.

```sh
systemctl --user start phantom-circuit
systemctl --user status phantom-circuit
journalctl --user -u phantom-circuit -f
```

Open `http://127.0.0.1:4317`. Closing the browser or development terminal does not stop a systemd-managed process. The browser reconnects after the service restarts and refreshes the work history without resending your messages.

To stop or restart:

```sh
systemctl --user stop phantom-circuit
systemctl --user restart phantom-circuit
```

The service listens on loopback only. To reach the server from another computer, forward its loopback port through your authenticated SSH connection:

```sh
ssh -N -L 4317:127.0.0.1:4317 your-server
```

Open the same loopback URL on your client. Do not expose the port through a public reverse proxy. Remote application authentication is not implemented.

## Keep working after logout and reboot

Enable startup explicitly:

```sh
systemctl --user enable phantom-circuit
```

A user service can stop when the account's final login session closes. If the team must work while you are logged out, ask your administrator to enable lingering for the service account:

```sh
loginctl enable-linger "$USER"
```

Verify it with `loginctl show-user "$USER" -p Linger`. Authentication that depends on an interactive SSH agent or unlocked keyring may need a separate unattended configuration. The installer does not copy credentials or make those decisions.

## Upgrade without changing the development checkout

Stop the service before installing a new release. In the desired checkout, run the installer again, then start the service:

```sh
systemctl --user stop phantom-circuit
npm run service -- install
systemctl --user start phantom-circuit
```

The installer leaves the current release selected if staging fails. Editing, rebuilding, or switching the development checkout does not change an installed release. Installation records the source revision and whether the source was modified. It does not assert that a modified snapshot is a published release.

Previous release directories remain available for diagnosis. Automatic code rollback and database restoration are not provided. An older runtime may not understand newer persisted state. Never replace the database with an old copy to undo a delivery that already changed GitHub.

## Remove the service registration

```sh
npm run service -- uninstall
```

Stop the service first. Uninstall removes the managed unit, not your projects, database, credentials, worktrees, or release directories.

## Verify a release without real work

Stage a release without registering a service:

```sh
npm run service -- stage --data-dir=/tmp/opencode/phantom-verification/.phantom
```

Run the release check with the resulting release path:

```sh
node scripts/service-smoke.mjs /absolute/path/to/release
```

The check uses disposable state and a free port. It loads the production runtime from another working directory, fetches the UI assets, saves a project, and checks one graceful restart and two crash restarts. It does not connect a repository or execute a model turn. Engine recovery tests cover active work separately with simulated model and GitHub boundaries.

On a host with a running user systemd manager, verify actual supervision:

```sh
node scripts/service-systemd-smoke.mjs /absolute/path/to/release
```

This creates a uniquely named temporary unit, checks two automatic crash restarts and retained project data, then removes its unit and disposable data. It does not start your installed team's unit.
