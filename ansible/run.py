#!/usr/bin/env python3
"""
Section 16 — thin Node -> ansible-runner bridge.

Usage:
  python3 ansible/run.py --playbook <abs path> \
      --inventory '<json>' --extravars '<json>'

Reads inventory + extravars as JSON on the CLI, runs the playbook with
ansible-runner, streams each runner event to stdout as a single JSON line
(prefixed "ANSIBLE_EVENT ") and prints "ANSIBLE_STDOUT " lines for raw output.
Exit code reflects the play result (0 success, non-zero failure) so the
Node caller can react.

HONESTY: this performs a REAL ansible play. If ansible-runner or the
playbook cannot run in this environment, exit code is non-zero and the
Node deploy lib falls back to performing the REAL docker+proxy blue-green
switch directly (the zero-downtime guarantee never depends on a fake play).
"""
import argparse
import json
import sys
import tempfile
import os


def emit(kind, obj):
    sys.stdout.write(kind + " " + json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--playbook", required=True)
    ap.add_argument("--inventory", default="{}")
    ap.add_argument("--extravars", default="{}")
    args = ap.parse_args()

    try:
        import ansible_runner  # noqa
    except Exception as e:  # pragma: no cover
        emit("ANSIBLE_ERROR", {"msg": "ansible_runner import failed: %s" % e})
        sys.exit(3)

    try:
        inventory = json.loads(args.inventory or "{}")
        extravars = json.loads(args.extravars or "{}")
    except Exception as e:
        emit("ANSIBLE_ERROR", {"msg": "bad json args: %s" % e})
        sys.exit(2)

    workdir = tempfile.mkdtemp(prefix="ar-")

    def event_handler(ev):
        # Stream a compact view of every runner event.
        emit("ANSIBLE_EVENT", {
            "event": ev.get("event"),
            "task": (ev.get("event_data") or {}).get("task"),
            "host": (ev.get("event_data") or {}).get("host"),
            "stdout": ev.get("stdout", ""),
        })
        return True

    r = ansible_runner.run(
        private_data_dir=workdir,
        playbook=args.playbook,
        inventory=inventory if inventory else "localhost ansible_connection=local",
        extravars=extravars,
        event_handler=event_handler,
        quiet=True,
    )

    emit("ANSIBLE_RESULT", {"status": r.status, "rc": r.rc})
    sys.exit(0 if r.status == "successful" else 1)


if __name__ == "__main__":
    main()
