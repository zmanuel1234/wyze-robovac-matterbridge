#!/bin/bash
# migrate-to-plus: move an installed matterbridge-wyze-robovac to matterbridge-wyze-robovac-plus.
#
#   sudo bash migrate-to-plus.sh                  install the GitHub release v1.1.0 and switch to it
#   sudo bash migrate-to-plus.sh PACKAGE.tgz      install that package file instead
#   sudo bash migrate-to-plus.sh --rollback       go back to matterbridge-wyze-robovac
#
# What it does: stops Matterbridge, backs up its settings and storage, installs the new package
# as the Matterbridge user, copies the plugin settings to the new name, registers the new plugin
# and unregisters the old one with Matterbridge's own CLI, then starts Matterbridge and waits
# for the plugin to come up. The old package stays installed so --rollback works; remove it later.
#
# In server mode (enableServerRvc) the vacuum's Matter identity is stored under the device name,
# not the plugin name, so Apple Home keeps the pairing. Cached Wyze tokens are not touched.
set -euo pipefail

OLD=matterbridge-wyze-robovac
NEW=matterbridge-wyze-robovac-plus
RELEASE_TAG=v1.1.0
REPO="zmanuel1234/wyze-robovac-matterbridge"
TOKEN_FILE="/etc/wyze-plugin-update/token"
MB_HOME="/opt/matterbridge"
PREFIX="$MB_HOME/.npm-global"
NODE_BIN="/opt/node22/bin"
BACKUP_DIR="$MB_HOME/plugin-backup"

die() { echo "migrate-to-plus: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run it with sudo"
systemctl cat matterbridge >/dev/null 2>&1 || die "no matterbridge service on this machine"

MB_USER=$(systemctl show -p User --value matterbridge); MB_USER=${MB_USER:-matterbridge}
MB_USER=$(id -nu "$MB_USER" 2>/dev/null || echo "$MB_USER")
# Matterbridge keeps its settings in <homedir>/.matterbridge; the service may set -homedir.
EXEC=$(systemctl show -p ExecStart --value matterbridge)
HOMEDIR=$(sed -n 's/.*-homedir[ =]\([^ ;]*\).*/\1/p' <<<"$EXEC")
HOMEDIR_ARGS=()
if [ -n "$HOMEDIR" ]; then HOMEDIR_ARGS=(-homedir "$HOMEDIR"); else HOMEDIR=$(getent passwd "$MB_USER" | cut -d: -f6); fi
MBDIR="$HOMEDIR/.matterbridge"
OLD_CFG="$MBDIR/$OLD.config.json"
NEW_CFG="$MBDIR/$NEW.config.json"

as_mb() { sudo -u "$MB_USER" -H env PATH="$PREFIX/bin:$NODE_BIN:/usr/bin:/bin" NPM_CONFIG_PREFIX="$PREFIX" \
  NPM_CONFIG_CACHE="$MB_HOME/.npm-cache" "$@"; }
mb_cli() { as_mb matterbridge "$@" "${HOMEDIR_ARGS[@]}" 2>&1 | sed 's/\x1b\[[0-9;]*[A-Za-z]//g'; }

wait_for_plugin() {   # wait_for_plugin NAME SINCE
  local log
  for _ in $(seq 1 24); do
    sleep 5
    log=$(journalctl -u matterbridge --since "$2" --no-pager -a -o cat | sed 's/\x1b\[[0-9;]*[A-Za-z]//g')
    if grep -q "Configured plugin $1\b" <<<"$log"; then
      grep -E "Initializing platform|Wyze helper started|Vacuum is|server mode|Configured plugin" <<<"$log" | tail -6
      return 0
    fi
    if grep -qE "Failed to (load|start|configure) plugin $1\b|Error parsing plugin $1\b" <<<"$log"; then
      grep -iE "robovac|error" <<<"$log" | tail -10
      return 1
    fi
  done
  echo "Matterbridge has not reported $1 as configured after 2 minutes."
  return 1
}

echo "Matterbridge user: $MB_USER, settings: $MBDIR"

if [ "${1:-}" = --rollback ]; then
  [ -d "$PREFIX/lib/node_modules/$OLD" ] || die "$OLD is no longer installed; restore a backup from $BACKUP_DIR instead"
  [ -f "$OLD_CFG" ] || die "$OLD_CFG is missing; restore a backup from $BACKUP_DIR instead"
  read -rp "Switch Matterbridge back to $OLD? Type yes: " a; [ "$a" = yes ] || die "cancelled"
  systemctl stop matterbridge
  mb_cli -remove "$NEW" | grep -E "Removed plugin|Failed" || true
  mb_cli -add "$OLD" | grep -E "Added plugin|already|Failed" || true
  since=$(date '+%Y-%m-%d %H:%M:%S'); systemctl start matterbridge
  wait_for_plugin "$OLD" "$since" && echo "Rolled back to $OLD." || die "rollback: $OLD did not come up; check journalctl -u matterbridge"
  exit 0
fi

# ---- Checks ----
[ -d "$PREFIX/lib/node_modules/$OLD" ] || die "$OLD is not installed in $PREFIX (nothing to migrate from)"
[ -f "$OLD_CFG" ] || die "settings file $OLD_CFG not found"
for c in python3 sha256sum journalctl; do command -v "$c" >/dev/null || die "$c is missing"; done

WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
chmod 755 "$WORK"

# ---- The package: a file given on the command line, or the GitHub release ----
if [ -n "${1:-}" ]; then
  [ -f "$1" ] || die "package file $1 not found"
  cp "$1" "$WORK/"
  TGZ="$WORK/$(basename "$1")"
else
  [ -r "$TOKEN_FILE" ] || die "no GitHub token in $TOKEN_FILE; pass a .tgz file instead"
  printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '[:space:]' < "$TOKEN_FILE")" > "$WORK/auth"; chmod 600 "$WORK/auth"
  api() { curl -fsSL --proto '=https' -K "$WORK/auth" -H "Accept: ${2:-application/vnd.github+json}" \
            -H "X-GitHub-Api-Version: 2022-11-28" "$1" || die "GitHub request failed ($1)"; }
  json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
  api "https://api.github.com/repos/$REPO/releases/tags/$RELEASE_TAG" > "$WORK/release.json"
  asset() { json "next(a['url'] for a in d['assets'] if $1)" < "$WORK/release.json"; }
  name=$(json "next(a['name'] for a in d['assets'] if a['name'].startswith('$NEW-') and a['name'].endswith('.tgz'))" < "$WORK/release.json") \
    || die "release $RELEASE_TAG has no $NEW package"
  api "$(asset "a['name'] == '$name'")" application/octet-stream > "$WORK/$name"
  api "$(asset "a['name'] == 'SHA256SUMS'")" application/octet-stream > "$WORK/SHA256SUMS"
  (cd "$WORK" && sha256sum --check --strict --ignore-missing SHA256SUMS) || die "checksum does not match; not installing"
  TGZ="$WORK/$name"
fi
chmod 644 "$TGZ"
tar xzOf "$TGZ" package/package.json | grep -q "\"name\": \"$NEW\"" || die "$TGZ is not a $NEW package"

cat <<EOF

This will:
  1. stop Matterbridge (the vacuum and your other Matterbridge devices go offline for a minute or two)
  2. back up $MBDIR and the installed $OLD to $BACKUP_DIR
  3. install $(basename "$TGZ") as $MB_USER
  4. copy $OLD.config.json to $NEW.config.json
  5. register $NEW with Matterbridge and unregister $OLD (still installed, for --rollback)
  6. start Matterbridge and wait for $NEW
EOF
read -rp "Type yes to continue: " a; [ "$a" = yes ] || die "cancelled"

echo "[1/6] Stopping Matterbridge"
systemctl stop matterbridge

echo "[2/6] Backup"
mkdir -p -m 700 "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
STAMP=$(date +%F-%H%M)
paths=("$MBDIR" "$PREFIX/lib/node_modules/$OLD")
[ -d "$HOMEDIR/Matterbridge" ] && paths+=("$HOMEDIR/Matterbridge")
# The backup holds the plugin settings (Wyze password), the token cache and Matter's
# storage: owner-only from the moment it is created.
( umask 077 && tar czf "$BACKUP_DIR/pre-plus-$STAMP.tgz" -P "${paths[@]}" )
chmod 600 "$BACKUP_DIR/pre-plus-$STAMP.tgz"
chown "$MB_USER:" "$BACKUP_DIR/pre-plus-$STAMP.tgz"
echo "      $BACKUP_DIR/pre-plus-$STAMP.tgz ($(du -h "$BACKUP_DIR/pre-plus-$STAMP.tgz" | cut -f1))"

echo "[3/6] Installing $NEW"
as_mb npm install --global --omit=dev --no-fund --no-audit --loglevel=error "$TGZ"
[ -f "$PREFIX/lib/node_modules/$NEW/package.json" ] || die "install failed; Matterbridge is stopped: run 'sudo systemctl start matterbridge'"

echo "[4/6] Settings"
if [ -f "$NEW_CFG" ]; then
  echo "      $NEW_CFG already exists; leaving it as it is"
else
  cp -p "$OLD_CFG" "$NEW_CFG"
  python3 - "$NEW_CFG" "$NEW" <<'PY'
import json, sys
path, name = sys.argv[1], sys.argv[2]
with open(path) as f:
    cfg = json.load(f)
cfg["name"] = name
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
PY
  echo "      copied to $NEW_CFG"
fi

echo "[5/6] Registering with Matterbridge"
mb_cli -add "$NEW" | grep -E "Added plugin|already|Failed" || true
mb_cli -remove "$OLD" | grep -E "Removed plugin|Failed" || true

echo "[6/6] Starting Matterbridge"
since=$(date '+%Y-%m-%d %H:%M:%S')
systemctl start matterbridge
if wait_for_plugin "$NEW" "$since"; then
  echo
  echo "Done. Check the vacuum in Apple Home (it should respond without pairing again)."
  echo "If anything is wrong: sudo bash $0 --rollback"
else
  die "$NEW did not come up. Go back with: sudo bash $0 --rollback"
fi
