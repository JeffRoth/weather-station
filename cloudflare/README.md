# Cloudflare deployment

This folder contains the Worker that archives Ambient Weather observations and exposes the dashboard API.

## One-time setup

1. Install Wrangler: `npm install -g wrangler`, then run `wrangler login`.
2. From this folder, create the private archive: `wrangler r2 bucket create weather-station-archive`.
3. In `wrangler.toml`, replace `ALLOWED_ORIGIN` with your future Cloudflare Pages URL.
4. Set secrets; they never enter Pages or Git:

   ```powershell
   wrangler secret put AMBIENT_API_KEY
   wrangler secret put AMBIENT_APPLICATION_KEY
   wrangler secret put AMBIENT_MAC
   ```

5. Deploy the collector/API: `wrangler deploy`.
6. Set an environment variable named `WEATHER_API_BASE` in Cloudflare Pages to the reported Worker URL with `/api` appended.
7. Create a Cloudflare Pages project from this repository. Set build command to `npm run build:pages` and output directory to `dist`. This publishes only the dashboard assets—never the CSV files, Worker source, or secrets.

The collector runs every 15 minutes and archives raw observations to `raw/YYYY/MM/` plus compact daily aggregates in `daily/YYYY.json`. The dashboard calls the aggregate API and never receives Ambient credentials.

## Initial history

The Worker begins archiving after deployment. Import the existing CSV history once:

```powershell
python scripts/export_daily.py --input data --output cloudflare/import/daily.json
wrangler secret put ADMIN_TOKEN
Invoke-RestMethod -Method Post -Uri 'https://YOUR-WORKER.workers.dev/api/admin/import-daily' -Headers @{ Authorization = 'Bearer YOUR_ADMIN_TOKEN' } -ContentType 'application/json' -InFile cloudflare/import/daily.json
```

The import endpoint is protected by `ADMIN_TOKEN`; it is never used by the dashboard. Preserve the original CSV files locally as an independent backup.
