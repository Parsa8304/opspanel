# Security model

OpsPanel is a **privileged** DevOps control panel. By design it can run commands
on the host (port scans, SSH config edits, infrastructure deploys) and manage
Docker containers. **The authentication layer is the entire security boundary** —
treat this panel like a root shell exposed over HTTP.

## Deployment requirements

- Run it on a host you control (a real VPS / bare metal), **not** managed PaaS.
- Put it behind a reverse proxy with TLS, ideally reachable only over a **VPN or
  private network**. Do not expose it to the public internet without one.
- Always set strong, unique secrets — the app refuses to start in production
  without them:
  - `JWT_SECRET` (>= 32 chars) — signs sessions; a leak lets anyone forge admin.
  - `PANEL_MASTER_KEY` (>= 16 chars) — encrypts SSH keys / TOTP secrets at rest.
- Change the seeded admin password immediately (a random one is generated on
  first seed and printed once).
- Enable TOTP 2FA for admin accounts (Access & Audit page).

## Privilege surface

The production compose runs the app container with `privileged: true` and
`pid: "host"`, and mounts the Docker socket, because the panel uses `nsenter`
to operate in the host's namespaces. Any RCE inside the container is therefore
root-on-host. To reduce this surface:

- Front the Docker socket with a socket-proxy (e.g. `tecnativa/docker-socket-proxy`)
  restricted to the endpoints you use.
- Drop `privileged` in favour of the specific capabilities you need.
- Restrict who can reach the panel at the network layer.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (Security →
Report a vulnerability) rather than a public issue.
