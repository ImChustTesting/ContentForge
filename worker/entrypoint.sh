#!/usr/bin/env bash
# Apply niceness if the kernel allows it (Linux hosts), else exec normally.
# nice/ionice are best-effort — Docker Desktop on macOS will silently skip.
set -e

if command -v ionice >/dev/null 2>&1; then
  exec nice -n 19 ionice -c2 -n7 "$@"
else
  exec "$@"
fi
