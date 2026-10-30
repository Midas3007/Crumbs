# Running Crumbs 24/7

A phone pauses apps in the background, so Crumbs needs a small always-on server. **Run only one copy at a time**:
stop it on the phone before starting it on a server, or both will race with the same wallet.

| Option | Cost | Notes |
|---|---|---|
| **Google Cloud e2-micro** (recommended) | Free (Always Free tier) | Real always-on Linux machine with a persistent disk. Card needed to sign up. Free only in `us-west1`, `us-central1` or `us-east1`. Check the current terms on Google's free-tier page. |
| Oracle Cloud Always Free | Free | Also a real VM, but Oracle may reclaim instances that stay mostly idle for 7 days, and Crumbs uses little CPU. |
| Render background worker | ~$7/month + disk | Easiest: `render.yaml` is ready. Render's free plan sleeps, so it won't work for a bot. |

All three can be done from a phone browser.

## Google Cloud (free), step by step

1. **Create the VM.** At console.cloud.google.com go to **Compute Engine → VM instances → Create instance**:
   - Region **us-central1** (or us-west1 / us-east1), machine type **e2-micro**
   - Boot disk: **Debian 12**, **Standard persistent disk**, 30 GB
   - Create it.
2. **Open a terminal on it.** Click **SSH** next to the VM. A terminal opens in the browser.
3. **Install Crumbs.** The repo is private, so make a read-only token first: GitHub → Settings → Developer settings →
   Fine-grained tokens → access to `Midas3007/Crumbs` only, permission **Contents: Read**. Then run:
   ```bash
   curl -fsSL -H "Authorization: Bearer YOUR_TOKEN" https://raw.githubusercontent.com/Midas3007/Crumbs/claude/dreamy-wright-inux8n/scripts/server-setup.sh -o setup.sh
   ```
   ```bash
   GITHUB_TOKEN=YOUR_TOKEN bash setup.sh
   ```
   If you make the repo public (judges will want to see it), drop the token parts.
4. **Copy your settings.** On the phone, run `cat .env` and copy everything. On the VM:
   ```bash
   nano ~/Crumbs/.env
   ```
   Paste, save (Ctrl+O, Enter, Ctrl+X).
5. **Copy the wallet key.** On the phone, run `cat keys/agent.json` and copy everything from `[` to `]`. On the VM:
   ```bash
   nano ~/Crumbs/keys/agent.json
   ```
   ```bash
   chmod 600 ~/Crumbs/keys/agent.json
   ```
6. **Stop Crumbs on the phone** (Ctrl+C in Termux), then start it on the VM:
   ```bash
   sudo systemctl restart crumbs
   ```
   ```bash
   journalctl -u crumbs -f
   ```
   You should get the "Crumbs started" message on Telegram.

**Updating later:** rerun the setup script (step 3). It pulls the latest code, rebuilds and restarts, and keeps your `.env`, key and history.

## Render (paid), step by step

1. **Stop Crumbs on your phone** (Ctrl+C). Only one copy may run with the wallet.
2. At dashboard.render.com: **New → Blueprint**, connect GitHub and pick `Midas3007/Crumbs`.
   Render reads `render.yaml`: a background worker in Virginia, a 1 GB disk for the history, Node 22.
   Set the branch to `claude/dreamy-wright-inux8n` if asked.
3. Render asks for the values marked secret. Copy them from your phone's `.env`:
   `HELIUS_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ANTHROPIC_API_KEY`, `DASHBOARD_SECRET`.
4. Click **Apply**. Before it starts, open the service, go to **Environment → Secret Files → Add**, name it
   `agent.json`, and paste the contents of `keys/agent.json` from the phone (`cat keys/agent.json`).
   Save; Render restarts the worker.
5. **Logs** shows the "starting" line, and Telegram gets "Crumbs started". It starts in shadow mode on a fresh
   disk, so send `/jobs` (approve TukTuk) and `/live` again.

Every push to the branch redeploys automatically; the disk keeps the history, approvals and live/shadow choice.

## Going live

Crumbs starts in shadow mode. On Telegram:
- `/jobs`: approve `tuktuk.run_task` (only approved job types are ever sent).
- `/live`: shows the go-live checklist (wallet key, balance within caps, kill switch) and a **🟢 Go live** button.
- `/shadow` switches back; `/pause` stops everything. The choice survives restarts.
