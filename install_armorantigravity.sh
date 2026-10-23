#!/usr/bin/env bash
set -euo pipefail

# ArmorAntigravity installer for Google Antigravity (2.0 app, IDE and the agy CLI).
#
# Usage:
#   curl -fsSL https://armoriq.ai/install_armorantigravity.sh | bash
#   bash install_armorantigravity.sh [--uninstall [--purge] [--logout]] [--force-login] [--skip-login]
#
# Downloads the release archive for this platform from GitHub, checks it against the release's
# SHA256SUMS, and runs `armorantigravity install` from it. That copies armoriq-agd, agd-hook and
# armorantigravity into ~/.armoriq/armorantigravity/bin, signs in with ArmorIQ's device login, merges
# the armoriq hooks and MCP server into ~/.gemini/config/hooks.json and mcp_config.json (comments and
# every other entry kept), writes ~/.gemini/config/rules/armoriq.md, and starts armoriq-agd as a
# launchd agent (macOS) or systemd user unit (Linux). Re-running upgrades in place.
#
# Flags:
#   --uninstall    remove everything install added and stop the daemon (keeps the login)
#   --purge        with --uninstall, also delete ~/.armoriq/armorantigravity
#   --logout       with --uninstall, also remove the ArmorAntigravity login profile
#   --force-login  sign in again even when a login exists
#   --skip-login   install without signing in (the daemon runs in monitor mode until you do)
#
# Environment:
#   ARMORANTIGRAVITY_CHANNEL      stable (default) or dev
#   ARMORIQ_BACKEND_URL           backend (default https://api.armoriq.ai; dev https://staging-api.armoriq.io)
#   ARMORANTIGRAVITY_VERSION      release tag to install, such as v0.1.0 (default: the newest
#                                 release; dev-latest on the dev channel)
#   ARMORANTIGRAVITY_RELEASE_URL  directory URL holding the archives and SHA256SUMS, instead of GitHub

REPO="armoriq/armorAntigravity"
CHANNEL="${ARMORANTIGRAVITY_CHANNEL:-stable}"
VERSION="${ARMORANTIGRAVITY_VERSION:-}"
RELEASE_URL="${ARMORANTIGRAVITY_RELEASE_URL:-}"
INSTALLED="${HOME}/.armoriq/armorantigravity/bin/armorantigravity"

if [[ -t 1 ]]; then
  R=$'\033[1;31m' G=$'\033[32m' B=$'\033[1m' D=$'\033[0;90m' N=$'\033[0m'
else
  R="" G="" B="" D="" N=""
fi
ok()   { printf "%s[ok]%s %s\n" "${G}" "${N}" "$*"; }
info() { printf "%s-%s %s\n" "${D}" "${N}" "$*"; }
err()  { printf "%s[error]%s %s\n" "${R}" "${N}" "$*" >&2; }
die()  { err "$*"; printf "%sNothing was changed.%s\n" "${R}" "${N}" >&2; exit 1; }

pwd >/dev/null 2>&1 || cd "${HOME:-/}"

DO_UNINSTALL=0
INSTALL_ARGS=()
UNINSTALL_ARGS=()
for arg in "$@"; do
  case "${arg}" in
    --uninstall) DO_UNINSTALL=1 ;;
    --purge|--logout) UNINSTALL_ARGS+=("${arg}") ;;
    --force-login|--skip-login) INSTALL_ARGS+=("${arg}") ;;
    -h|--help) sed -n '4,30p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null || true; exit 0 ;;
    *) err "unknown argument: ${arg}"; exit 2 ;;
  esac
done
if [[ "${DO_UNINSTALL}" -eq 0 && "${#UNINSTALL_ARGS[@]}" -gt 0 ]]; then
  err "${UNINSTALL_ARGS[*]} only applies with --uninstall"; exit 2
fi
case "${CHANNEL}" in
  stable|dev) ;;
  *) err "ARMORANTIGRAVITY_CHANNEL must be stable or dev, got ${CHANNEL}"; exit 2 ;;
esac

platform() {
  local os arch
  case "$(uname -s)" in
    Darwin) os="darwin" ;;
    Linux) os="linux" ;;
    *) die "unsupported OS $(uname -s); ArmorAntigravity supports macOS and Linux" ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64) arch="x64" ;;
    *) die "unsupported CPU $(uname -m)" ;;
  esac
  # A shell under Rosetta reports x86_64 on Apple silicon; the native build is the right one.
  if [[ "${os}" == "darwin" && "${arch}" == "x64" && "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" == "1" ]]; then
    arch="arm64"
  fi
  printf '%s-%s' "${os}" "${arch}"
}

release_base() {
  if [[ -n "${RELEASE_URL}" ]]; then printf '%s' "${RELEASE_URL%/}"; return; fi
  local tag="${VERSION}"
  [[ -z "${tag}" && "${CHANNEL}" == "dev" ]] && tag="dev-latest"
  if [[ -z "${tag}" ]]; then
    printf 'https://github.com/%s/releases/latest/download' "${REPO}"
  else
    printf 'https://github.com/%s/releases/download/%s' "${REPO}" "${tag}"
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "sha256sum or shasum is required to verify the download"
  fi
}

# Prints the directory holding the verified, unpacked binaries.
fetch_release() {
  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v tar >/dev/null 2>&1 || die "tar is required"
  local base archive want got
  base="$(release_base)"
  archive="armorantigravity-$(platform).tar.gz"
  info "downloading ${base}/${archive}" >&2
  curl -fsSL --retry 2 "${base}/SHA256SUMS" -o "${WORK}/SHA256SUMS" || die "could not download ${base}/SHA256SUMS"
  curl -fSL --retry 2 --progress-bar "${base}/${archive}" -o "${WORK}/${archive}" || die "could not download ${base}/${archive}"
  want="$(awk -v f="${archive}" '$2 == f || $2 == "*" f { print $1 }' "${WORK}/SHA256SUMS")"
  [[ -n "${want}" ]] || die "SHA256SUMS has no entry for ${archive}"
  got="$(sha256 "${WORK}/${archive}")"
  [[ "${got}" == "${want}" ]] || die "checksum mismatch for ${archive}: expected ${want}, got ${got}"
  ok "verified ${archive} (sha256 ${got})" >&2
  mkdir -p "${WORK}/bin"
  tar -xzf "${WORK}/${archive}" -C "${WORK}/bin" armoriq-agd agd-hook armorantigravity || die "could not unpack ${archive}"
  printf '%s' "${WORK}/bin"
}

main() {
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/armorantigravity.XXXXXX")"
  trap 'rm -rf "${WORK}"' EXIT

  if [[ "${DO_UNINSTALL}" -eq 1 ]]; then
    if [[ -x "${INSTALLED}" ]]; then
      "${INSTALLED}" uninstall ${UNINSTALL_ARGS[@]+"${UNINSTALL_ARGS[@]}"}
    else
      local bin
      bin="$(fetch_release)"
      "${bin}/armorantigravity" uninstall ${UNINSTALL_ARGS[@]+"${UNINSTALL_ARGS[@]}"}
    fi
    return
  fi

  printf "%sArmorAntigravity installer%s %s(%s channel)%s\n" "${B}" "${N}" "${D}" "${CHANNEL}" "${N}"
  local bin args
  bin="$(fetch_release)"
  args=(install --channel "${CHANNEL}")
  [[ -n "${ARMORIQ_BACKEND_URL:-}" ]] && args+=(--backend "${ARMORIQ_BACKEND_URL}")
  # The device login polls the backend and never reads stdin, which is the script itself under curl | bash.
  "${bin}/armorantigravity" "${args[@]}" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"} </dev/null
}

main "$@"
