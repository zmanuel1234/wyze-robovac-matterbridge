#!/bin/bash
# wyze-plugin-update: install the newest GitHub release of matterbridge-wyze-robovac on this Pi.
#
#   sudo wyze-plugin-update check      what is installed (version, commit) vs. the newest release
#   sudo wyze-plugin-update            install the newest release if it is newer, then restart Matterbridge
#   sudo wyze-plugin-update v1.0.12    install that release (also to go back to an older one)
#   sudo wyze-plugin-update restore 1.0.11   put back a version this script backed up, and restart
#
# Releases are built and tested by GitHub (.github/workflows/release.yml); this script only
# installs them, after checking the SHA-256 checksum published with the release. The previous
# version is copied to /opt/matterbridge/plugin-backup/<version> first.
#
# The repository is private, so this needs a GitHub token that can only read it, in
# /etc/wyze-plugin-update/token (root-only). It is sent only to api.github.com, never shown,
# and never put on a command line.
set -euo pipefail

REPO="zmanuel1234/wyze-robovac-matterbridge"
TOKEN_FILE="/etc/wyze-plugin-update/token"
MB_HOME="/opt/matterbridge"
PREFIX="$MB_HOME/.npm-global"
PLUGIN_DIR="$PREFIX/lib/node_modules/matterbridge-wyze-robovac"
BACKUP_DIR="$MB_HOME/plugin-backup"
NODE_BIN="/opt/node22/bin"

die() { echo "wyze-plugin-update: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run it with sudo"

if [ "${1:-}" = restore ]; then
  v="${2:-}"
  [ -n "$v" ] && [ -d "$BACKUP_DIR/$v" ] || die "usage: restore VERSION; backed up: $(ls "$BACKUP_DIR" 2>/dev/null | tr '\n' ' ')"
  rm -rf "$PLUGIN_DIR"
  cp -a "$BACKUP_DIR/$v" "$PLUGIN_DIR"
  systemctl restart matterbridge
  echo "Restored $v and restarted Matterbridge."
  exit 0
fi
[ -r "$TOKEN_FILE" ] || die "no GitHub token in $TOKEN_FILE (see the runbook: 'Updates from GitHub')"
for c in curl python3 sha256sum systemctl; do command -v "$c" >/dev/null || die "$c is missing"; done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '[:space:]' < "$TOKEN_FILE")" > "$WORK/auth"
chmod 600 "$WORK/auth"

api() {   # api URL [ACCEPT] -> body on stdout
  curl -fsSL --proto '=https' -K "$WORK/auth" -H "Accept: ${2:-application/vnd.github+json}" \
       -H "X-GitHub-Api-Version: 2022-11-28" "$1" \
    || die "GitHub request failed ($1). Is the token valid and allowed to read $REPO?"
}
json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

installed_version() { [ -f "$PLUGIN_DIR/package.json" ] && json "d['version']" < "$PLUGIN_DIR/package.json" || echo none; }
installed_build() {
  if [ -f "$PLUGIN_DIR/build-info.json" ]; then
    json "'release ' + d['tag'] + ', commit ' + d['commit'][:7] + ', built ' + d['built'][:10]" < "$PLUGIN_DIR/build-info.json"
  else
    echo "not installed from a GitHub release"
  fi
}

want="${1:-latest}"
case "$want" in
  check|latest) api "https://api.github.com/repos/$REPO/releases/latest" > "$WORK/release.json" ;;
  v*)           api "https://api.github.com/repos/$REPO/releases/tags/$want" > "$WORK/release.json" ;;
  -h|--help)    sed -n '2,16p' "$0"; exit 0 ;;
  *)            die "unknown argument '$want' (use: check, a tag like v1.0.12, or nothing)" ;;
esac
tag=$(json "d['tag_name']" < "$WORK/release.json")
have=$(installed_version)

echo "Installed: $have ($(installed_build))"
echo "On GitHub: ${tag#v} (release $tag, $(json "d['published_at'][:10]" < "$WORK/release.json"))"
if [ "$want" = check ]; then
  [ "v$have" = "$tag" ] && echo "Up to date." || echo "Run 'sudo wyze-plugin-update' to install $tag."
  exit 0
fi
if [ "$want" = latest ] && [ "v$have" = "$tag" ] && [ -f "$PLUGIN_DIR/build-info.json" ]; then
  echo "Already up to date."
  exit 0
fi

# Download the package and the checksum file attached to the release.
asset_url() { json "next(a['url'] for a in d['assets'] if $1)" < "$WORK/release.json"; }
tgz_name=$(json "next(a['name'] for a in d['assets'] if a['name'].endswith('.tgz'))" < "$WORK/release.json") \
  || die "release $tag has no .tgz package"
api "$(asset_url "a['name'].endswith('.tgz')")" application/octet-stream > "$WORK/$tgz_name"
api "$(asset_url "a['name'] == 'SHA256SUMS'")" application/octet-stream > "$WORK/SHA256SUMS"
(cd "$WORK" && sha256sum --check --strict SHA256SUMS) || die "checksum does not match; not installing"

# Back up what is installed, then install as the matterbridge user, like the runbook does.
if [ "$have" != none ]; then
  mkdir -p "$BACKUP_DIR"
  rm -rf "${BACKUP_DIR:?}/$have"
  cp -a "$PLUGIN_DIR" "$BACKUP_DIR/$have"
  chown -R matterbridge:matterbridge "$BACKUP_DIR"
  echo "Backed up $have to $BACKUP_DIR/$have"
fi
chmod 755 "$WORK"
chmod 644 "$WORK/$tgz_name"
sudo -u matterbridge -H env PATH="$PREFIX/bin:$NODE_BIN:/usr/bin:/bin" NPM_CONFIG_PREFIX="$PREFIX" \
  NPM_CONFIG_CACHE="$MB_HOME/.npm-cache" npm install --global --omit=dev --no-fund --no-audit "$WORK/$tgz_name"

echo "Installed $(installed_version) ($(installed_build)). Restarting Matterbridge..."
since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl restart matterbridge
for _ in $(seq 1 24); do   # up to 2 minutes for the plugin to come up
  sleep 5
  log=$(journalctl -u matterbridge --since "$since" --no-pager -a -o cat | sed 's/\x1b\[[0-9;]*[A-Za-z]//g')
  if grep -q "Configured plugin matterbridge-wyze-robovac" <<<"$log"; then
    grep -E "Initializing platform|Wyze helper started|Vacuum is|Configured plugin" <<<"$log" | tail -5
    echo "Done."
    exit 0
  fi
  if grep -qE "Failed to (load|start|configure) plugin matterbridge-wyze-robovac|Error parsing plugin matterbridge-wyze-robovac" <<<"$log"; then
    grep -iE "robovac|error" <<<"$log" | tail -10
    die "Matterbridge did not accept $tag. Go back with: sudo wyze-plugin-update restore $have"
  fi
done
echo "Matterbridge has not reported the plugin as configured after 2 minutes; check with:"
echo "  journalctl -u matterbridge --since '$since' --no-pager -a -o cat | tail -40"
