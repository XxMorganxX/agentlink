#!/bin/sh
# curl -fsSL https://github.com/XxMorganxX/agentlink/releases/latest/download/install.sh | sh
# curl -fsSL …/install.sh | sh -s -- https://crm.stuart-labs.com XXXX-XXXX     (install and pair in one go)
# Downloads the agentlink binary for this Mac, puts it in ~/.local/bin, starts the
# background agent, and pairs it when an origin and code are given. Installs Claude Code first if it is missing.
set -eu
if [ "$#" -eq 1 ]; then echo "usage: curl -fsSL …/install.sh | sh -s -- <origin> <code>" >&2; exit 2; fi
repo="XxMorganxX/agentlink"  # public; the source repo is private, so its release files 404 anonymously
os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"
case "$arch" in x86_64) arch="x64" ;; arm64|aarch64) arch="arm64" ;; esac
[ "$os" = "darwin" ] || { echo "agentlink currently supports macOS only" >&2; exit 1; }
asset="agentlink-${os}-${arch}"
dest="${HOME}/.local/bin/agentlink"
mkdir -p "$(dirname "$dest")"
echo "downloading ${asset}…"
# Download beside the binary and rename over it: a running daemon keeps its old inode instead of being truncated under it.
curl -fsSL "https://github.com/${repo}/releases/latest/download/${asset}" -o "$dest.tmp"
chmod +x "$dest.tmp"
mv -f "$dest.tmp" "$dest"
# agentlink install refuses without Claude Code; its own installer puts it in ~/.local/bin, where install looks first.
if [ ! -x "${HOME}/.local/bin/claude" ] && ! /bin/zsh -lc 'command -v claude' >/dev/null 2>&1; then
  echo "Claude Code not found; installing it…"
  curl -fsSL https://claude.ai/install.sh | bash
  new_claude=1
fi
"$dest" install
if [ -n "${new_claude:-}" ]; then echo "Claude Code is installed. Run \`claude\` once to sign in; tasks need it."; fi
if [ "$#" -ge 2 ]; then "$dest" pair "$1" "$2"; fi
case ":$PATH:" in *":${HOME}/.local/bin:"*) ;; *) echo "note: add ~/.local/bin to your PATH to run agentlink from a shell (the background agent does not need it)";; esac
