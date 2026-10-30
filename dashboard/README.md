# Crumbs dashboard

Public, read-only dashboard for the Crumbs agent: net P&L (SOL and USD), crumbs eaten, win rate, fees,
daily live vs shadow earnings, jobs by type, recent transactions (Solscan links), the discovery feed and a share card.

```
agent (phone / Render) ──POST /api/snapshot (Bearer secret, every minute)──► this app ──► Vercel Blob (private)
                                                                                 └──► page, /api/card, GET /api/snapshot
```

The agent never needs anything installed for this: it sends a JSON snapshot with plain `fetch`.

## Deploy on Vercel

1. Import the GitHub repo in Vercel and set **Root Directory** to `dashboard`. The framework is detected as Next.js.
2. In the project, go to **Storage → Create → Blob** and connect the store. That sets `BLOB_READ_WRITE_TOKEN` for you.
3. Add the environment variable `CRUMBS_PUSH_SECRET`: any long random string. To make one:
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```
4. Deploy. Then put in the agent's `.env`:
   ```
   DASHBOARD_URL=https://<your-project>.vercel.app
   DASHBOARD_SECRET=<the same secret>
   ```
   Within a minute of restarting the agent, the dashboard shows live data.

## Run locally

```bash
npm install
```

```bash
SNAPSHOT_FILE=../data/snapshot.json npm run dev
```

The agent writes `data/snapshot.json` every minute, so a locally running agent feeds the local dashboard.

## Endpoints

| Path | What |
|---|---|
| `/` | The dashboard |
| `/api/card` | 1200×630 share image ("Crumbs ate N crumbs today…"); also the page's social preview |
| `GET /api/snapshot` | The raw data, public, for anyone who wants to verify or build on it |
| `POST /api/snapshot` | Agent only (`Authorization: Bearer $CRUMBS_PUSH_SECRET`) |
