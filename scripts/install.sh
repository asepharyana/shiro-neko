#!/usr/bin/env sh
# Installs shiro-neko from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/zakirkun/shiro-neko/main/scripts/install.sh | sh
#
# Set SHIRO_VERSION to pin a version, SHIRO_INSTALL_DIR to change the target.
set -eu

REPO="${SHIRO_REPO:-zakirkun/shiro-neko}"
INSTALL_DIR="${SHIRO_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "shiro: unsupported OS $(uname -s). Windows users: use scripts/install.ps1" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) echo "shiro: unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac

asset="shiro-${os}-${arch}"

if [ -n "${SHIRO_VERSION:-}" ]; then
  tag="v${SHIRO_VERSION#v}"
  base="https://github.com/${REPO}/releases/download/${tag}"
else
  base="https://github.com/${REPO}/releases/latest/download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "downloading ${asset} from ${base}"
if ! curl -fSL --progress-bar "${base}/${asset}" -o "${tmp}/shiro"; then
  echo "shiro: download failed. No build for ${os}-${arch} at that version?" >&2
  exit 1
fi

# Verify against the published checksums when they are available; a corrupted
# 90 MB download otherwise fails later as an unexplained crash.
if curl -fsSL "${base}/SHA256SUMS" -o "${tmp}/SHA256SUMS" 2>/dev/null; then
  expected="$(grep " ${asset}\$" "${tmp}/SHA256SUMS" | cut -d' ' -f1)"
  if [ -n "$expected" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "${tmp}/shiro" | cut -d' ' -f1)"
    elif command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "${tmp}/shiro" | cut -d' ' -f1)"
    else
      actual=""
    fi
    if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
      echo "shiro: checksum mismatch, refusing to install" >&2
      exit 1
    fi
  fi
fi

mkdir -p "$INSTALL_DIR"
chmod +x "${tmp}/shiro"
mv "${tmp}/shiro" "${INSTALL_DIR}/shiro"

echo "installed ${INSTALL_DIR}/shiro"
"${INSTALL_DIR}/shiro" --version || true

case ":${PATH}:" in
  *":${INSTALL_DIR}:"*) echo "run: shiro" ;;
  *) echo ""; echo "${INSTALL_DIR} is not on PATH. Add it:"; echo "  export PATH=\"${INSTALL_DIR}:\$PATH\"" ;;
esac
