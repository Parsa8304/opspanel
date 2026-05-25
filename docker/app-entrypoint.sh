#!/bin/sh
set -e
# Allow git operations on the read-only mounted product repo (different uid).
git config --global --add safe.directory '*' 2>/dev/null || true
echo "[entrypoint] waiting for database…"
i=0
until npx prisma db push --skip-generate --accept-data-loss >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -ge 30 ]; then
    echo "[entrypoint] db not reachable after 30 tries — running push once more (verbose):"
    npx prisma db push --skip-generate
    break
  fi
  sleep 2
done
echo "[entrypoint] schema in sync; seeding (idempotent)…"
npx tsx prisma/seed.ts || echo "[entrypoint] seed step reported an issue (continuing — seed is idempotent)"
echo "[entrypoint] starting Next.js on :3000"
exec npm run start -- -p 3000 -H 0.0.0.0
