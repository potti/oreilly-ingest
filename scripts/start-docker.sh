#!/usr/bin/env bash
# Stop compose stack, remove the built image, then bring the service up again (rebuild).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> git pull"
git pull

echo "==> docker compose down"
docker compose down --remove-orphans

echo "==> remove image oreilly-ingest-oreilly-ingest (if present)"
# Compose default image name: <project_dir>_<service>; service is oreilly-ingest in docker-compose.yml.
if imgs=$(docker images -q oreilly-ingest-oreilly-ingest 2>/dev/null); test -n "${imgs}"; then
  docker rmi -f ${imgs}
else
  echo "    (image not found, skip)"
fi

echo "==> docker compose up -d --build"
docker compose up -d --build

echo "==> status"
docker compose ps
