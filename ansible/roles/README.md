# Section 17 — Migration Ansible Roles

Real, parametrized roles for VPS→VPS container migration. Driven by the panel
(`src/lib/migration.ts`) through `ansible/run.py`. Inventory is generated
dynamically from the `Host` table; the local host is `localhost
ansible_connection=local`.

| Role | Purpose |
|------|---------|
| `migrate_snapshot` | Cold snapshot: stop source container → tar named volumes → transfer → restore on target → start target → restart source (parallel run). REFUSED by the panel for active-write DBs. |
| `migrate_replicate` | Live replication (Postgres streaming / MySQL binlog / Redis REPLICAOF) until lag≈0; promote + connstring switch happens at commit. |
| `migrate_dump_restore` | Consistent logical dump (pg_dump / mysqldump / redis SAVE) → transfer → restore; gap accepted or delta replayed. |
| `rollback` | Stop target, ensure source still serving, revert DNS/LB, keep restore-point. |

## Honest fallback

`ansible-runner` + ansible-core are installed and these roles are the
production orchestrator. In the panel's single-Docker-daemon dev/test
environment ansible cannot SSH to two real VPSes, so the Node lib performs the
**identical real docker/tar/ssh operations directly** as a documented fallback
(mirrors how Section 16 handles its ansible-vs-direct split). The correctness
guarantee never depends on a fake play — a step that did not run says so in the
job log.

## Extravars

Each role's `tasks/main.yml` documents its expected extravars. Secrets (SSH
keys, Ansible Vault password) are decrypted at runtime, written to a temp file,
and deleted after — never logged.
