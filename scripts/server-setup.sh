#!/usr/bin/env bash
# One-command setup for Crumbs on any small Linux server (Debian/Ubuntu): Google Cloud e2-micro,
# Oracle Always Free, a $4 VPS... Installs Node 22, the code, and a service that restarts on crash/reboot.
#
#   bash server-setup.sh                      # public repo
#   GITHUB_TOKEN=github_pat_... bash server-setup.sh   # private repo (read-only fine-grained token)
#
# Afterwards: put your .env and keys/agent.json in ~/Crumbs (see DEPLOY.md), then
#   sudo systemctl restart crumbs && journalctl -u crumbs -f
set -euo pipefail

REPO="Midas3007/Crumbs"
BRANCH="${BRANCH:-claude/dreamy-wright-inux8n}"
DIR="$HOME/Crumbs"

echo "==> Swap (small servers have ~1 GB RAM; installs and builds need more)"
if ! swapon --show | grep -q swapfile; then
  sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  sudo apt-get update -y && sudo apt-get install -y ca-certificates curl git
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "==> Code"
URL="https://github.com/$REPO.git"
[ -n "${GITHUB_TOKEN:-}" ] && URL="https://x-access-token:${GITHUB_TOKEN}@github.com/$REPO.git"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$URL" "$DIR"
  # Don't keep the token in the saved remote URL.
  git -C "$DIR" remote set-url origin "https://github.com/$REPO.git"
fi
cd "$DIR"
npm ci --no-audit --no-fund
npm run build
mkdir -p keys data && chmod 700 keys

echo "==> Service (starts on boot, restarts on crash)"
sudo tee /etc/systemd/system/crumbs.service >/dev/null <<EOF
[Unit]
Description=Crumbs keeper agent
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$DIR
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning dist/src/index.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable crumbs >/dev/null

if [ -f "$DIR/.env" ]; then
  sudo systemctl restart crumbs
  echo "==> Crumbs is running. Logs: journalctl -u crumbs -f"
else
  echo "==> Installed. Next: create $DIR/.env and $DIR/keys/agent.json (see DEPLOY.md), then: sudo systemctl restart crumbs"
fi
