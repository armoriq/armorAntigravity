#!/usr/bin/env bash
set -euo pipefail

archive="${1:?release archive is required}"
version="${2:?expected version is required}"
root="$(mktemp -d /tmp/agy-smoke.XXXXXX)"
daemon_pid=""
cleanup() {
  if [[ -n "${daemon_pid}" ]]; then
    kill "${daemon_pid}" 2>/dev/null || true
    wait "${daemon_pid}" 2>/dev/null || true
  fi
  rm -rf "${root}"
}
trap cleanup EXIT
mkdir -p "${root}/bin" "${root}/home"
tar -xzf "${archive}" -C "${root}/bin"
test "$("${root}/bin/armorantigravity" --version)" = "${version}"
env -i HOME="${root}/home" PATH="${PATH}" "${root}/bin/armoriq-agd" > "${root}/daemon.log" 2>&1 &
daemon_pid=$!
for _ in {1..100}; do
  [[ -S "${root}/home/.armoriq/armorantigravity/agd.sock" ]] && break
  kill -0 "${daemon_pid}" || { cat "${root}/daemon.log"; exit 1; }
  sleep 0.1
done
test -S "${root}/home/.armoriq/armorantigravity/agd.sock"
hook_output="$(env -i HOME="${root}/home" PATH="${PATH}" "${root}/bin/agd-hook")"
test -z "${hook_output}"
env -i HOME="${root}/home" PATH="${PATH}" "${root}/bin/armorantigravity" status | grep -F 'daemon: listening'
kill "${daemon_pid}"
wait "${daemon_pid}"
daemon_pid=""
