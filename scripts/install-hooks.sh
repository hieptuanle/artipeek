#!/bin/sh
# Installs the git pre-commit hook (runs on `bun install` via package.json "postinstall").
# The installed hook is a small wrapper that runs scripts/pre-commit from the checkout, so edits to
# that file apply without reinstalling. Never overwrites a pre-commit hook it did not install.
MARK="# artipeek-hook-wrapper"
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0     # not a git checkout (e.g. a tarball): nothing to do
[ -f "$top/scripts/pre-commit" ] || exit 0
hooks=$(git rev-parse --git-path hooks) || exit 0               # respects core.hooksPath and worktrees
case $hooks in /*) ;; *) hooks="$(pwd)/$hooks" ;; esac
mkdir -p "$hooks"
dst="$hooks/pre-commit"
if [ -e "$dst" ] && ! grep -q "$MARK" "$dst"; then
  echo "install-hooks: $dst already exists and is not ours; left it alone." >&2
  echo "install-hooks: to use the secrets scan, add this line to it: \"\$(git rev-parse --show-toplevel)/scripts/pre-commit\" || exit 1" >&2
  exit 0
fi
cat > "$dst" <<HOOK
#!/bin/sh
$MARK (installed by scripts/install-hooks.sh; re-run: bun install)
exec "\$(git rev-parse --show-toplevel)/scripts/pre-commit" "\$@"
HOOK
chmod +x "$dst" "$top/scripts/pre-commit"
echo "install-hooks: pre-commit secrets scan installed ($dst)"
