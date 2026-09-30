# Development workspace

This project supports a primary Linux SSH checkout. When a Windows checkout has
`.tools/remote/connection.json`, treat that local checkout as an SSH entrypoint and
backup, not the primary development tree.

- Read the connection file without exposing credentials. Use
  `pwsh -NoProfile -File scripts/dev/remote.ps1 -Action status` first.
- Perform project reads, edits, builds, tests, model runs and Git commits in the
  configured remote root. The `-Command` and `-ScriptFile` modes execute Bash and
  load `scripts/dev/remote-env.sh` there.
- Local edits are appropriate for repairing the SSH entrypoint itself. Do not
  silently switch project work back to Windows when SSH is unavailable.
- Keep the remote working tree authoritative; inspect its changes before pulls.
  Use fast-forward pulls and never overwrite uncommitted changes.
- Connection metadata, credentials, model caches, original datasets and review
  outputs remain outside Git. Preserve frozen review packages and their hashes.
- Temporary runtime storage may be cleared by the host. Keep code in Git and
  human annotations in persistent storage, with backups of important outputs.
- Select shared GPU devices explicitly for requested runs. Installing or testing
  the environment does not authorize formal dataset training.

See `docs/remote-development.md` for installation, verification and port forwarding.
