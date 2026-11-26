#!/bin/sh
# The always-on relay: a systemd user unit that runs server.ts on
# 127.0.0.1:7733 (or $BATON_PORT when set) and restarts it if it exits. Linger keeps it
# running without a login session. Idempotent.
# `--uninstall` removes the unit (the key and pairings in the config dir stay).
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
unit="$HOME/.config/systemd/user/baton.service"

if [ "${1:-}" = "--uninstall" ]; then
  systemctl --user disable --now baton.service 2>/dev/null || true
  rm -f "$unit"
  systemctl --user daemon-reload
  echo "baton service removed"
  exit 0
fi

port=${BATON_PORT:-7733}
bun=$(command -v bun || echo "$HOME/.bun/bin/bun")
mkdir -p "$(dirname "$unit")"
cat > "$unit" <<EOF
[Unit]
Description=baton: http://localhost:$port, relay between Claude Code and Claude in Chrome (127.0.0.1 only)
After=network-online.target

[Service]
WorkingDirectory=$root
ExecStart=$bun $root/server.ts
Restart=always
RestartSec=5
Environment=BATON_PORT=$port
Environment=PATH=$(dirname "$bun"):/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
EOF

loginctl show-user "$(id -un)" -p Linger | grep -q '=yes' || sudo loginctl enable-linger "$(id -un)"
systemctl --user daemon-reload
systemctl --user enable --now baton.service
systemctl --user restart baton.service
echo "baton service installed and started: http://localhost:$port (logs: journalctl --user -u baton)"
