# AlgoLens

A website that turns Tradetron share codes into public performance reports: a leaderboard, a full report per strategy, side-by-side comparison and a portfolio builder. It re-reads every shared deployment each night.

## How it works

AlgoLens reads your Tradetron account, read-only, in two ways:

| What | How often | Source | Used for |
|---|---|---|---|
| **Live** status, counter P&L, booked/open P&L, open positions | every 15 min, 09:00–23:45 IST on weekdays, while the site runs | `/api/deployments?scope=deployed` (yours) and `scope=shared` (share codes you added) | Dashboard |
| **History**: daily P&L since deployment | once a day at 23:45 IST, at start-up if it hasn't run today, and right away for any newly added strategy | `/api/p/stats?tid=<SID>` (the Statistics page) | Performance, reports, Compare, Portfolio |

A live refresh is about 4 small requests. Nothing is ever changed on Tradetron.

**Add a strategy:** deploy it, or add its share code under Shared Codes in Tradetron. It appears on the Dashboard at the next live refresh, and its history is fetched straight after.
**Remove one:** hide it on `/admin`, or archive the deployment / delete the share code in Tradetron.
**Choose what you see:** the All / Mine / Shared switch in the top bar applies to every page, and the Dashboard's **Columns** button picks the columns. Both are remembered in your browser.

## Pages

| Page | What it shows |
|---|---|
| **Dashboard** | Capital, today's and all-time P&L, open positions; the intraday P&L curve; the strategy breakdown (today, all-time, drawdown now vs worst, status, intraday/positional, multiplier, days live, copy share code) with a totals row; top performers by average monthly return |
| **Monitor** | One card per strategy with today and all-time P&L, and Error / P&L alert switches. Strategies that disappear from your account are flagged |
| **Performance, Compare, Portfolio** | Full history analytics |
| **Alerts** | P&L digest schedule, MCX evening, end-of-day summaries, error alerts, 1x P&L, day's high/low, footer links, Detailed or Sleek format with live preview, alert history |
| **Settings** | Telegram bot and channels (presets: All / Errors only / P&L only, per-channel strategy scope), Discord webhooks, aliases, show/hide, intraday/positional override, Tradetron session, refresh interval |

**Today's P&L** matches Tradetron's own: the current counter's P&L for intraday strategies, and now minus the previous close for positional ones.

## Telegram alerts in 3 steps

1. In Telegram, message **@BotFather**, send `/newbot`, and copy the token it gives you.
2. On **Settings**, paste the token and click **Save token**.
3. Press **Start** on your bot (for a personal chat), or add the bot as an admin to a group or channel and post a message there. Then click **Find my chats**, **Add**, **Save channels**, and **Send test**.

Alerts are sent only while AlgoLens is running on your computer.

## What's in this folder

| File | Purpose |
|---|---|
| `server.js` | Website, admin page and the nightly schedule |
| `collector.js` | Reads shared deployments from Tradetron |
| `web/analytics.js` | All the maths (drawdowns, Sharpe, heatmaps, correlation) |
| `web/app.template.html` | The website's pages |
| `data/` | Collected data. Ships with the 30 Sep 2026 snapshot so the site works immediately |
| `enrich.js` | Today's P&L, intraday/positional, drawdowns, intraday snapshots |
| `alerts.js` | P&L digests, end-of-day summaries, error alerts, Telegram and Discord |
| `test/` | Automated checks (`npm test`), including a simulated trading day of alerts |

No third-party packages. It needs only **Node.js 22 or newer**.

## Run it on your computer

```bash
cp .env.example .env      # then open .env and set ADMIN_PASSWORD
npm start                 # open http://localhost:3000
```

The admin page is at `/admin` (any username, your ADMIN_PASSWORD).

## Connect the Tradetron account

The collector uses the Tradetron sign-in session from your browser. Tradetron's login has a robot check, so the collector does not sign in by itself, and it never stores your password.

1. In Chrome, sign in to tradetron.tech with the AlgoLens account.
2. Open the Deployed page, press **F12**, choose the **Network** tab, then refresh the page.
3. Click any request whose name starts with `deployments?scope=`.
4. Under **Request Headers**, find **Cookie** and copy its entire value.
5. Paste it on your site's `/admin` page under **Tradetron session**, then click **Sync now**.

Treat this cookie like a password. Anyone with it can use that Tradetron account until it expires, so use a separate Tradetron account for AlgoLens rather than your trading account.

When the session expires, syncs stop and the admin page shows **Session expired**. Old data stays on the site. Repeat the steps above to resume. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env` to get a Telegram message when that happens.

## Put it online

The site needs a server that stays on, so the nightly sync can run, with a disk that keeps the `data/` folder.

**Easiest: Railway** (about $5 a month)
1. Upload this folder to a private GitHub repository.
2. On railway.app create a project from that repository. It detects Node and runs `npm start`.
3. Add a **Volume** mounted at `/app/data`.
4. Under Variables, set `ADMIN_PASSWORD`, and optionally `SYNC_TIME` and the Telegram variables.
5. Under Settings → Networking, generate a domain, or connect your own.

**Or a small VPS** (DigitalOcean, Hostinger and similar, ₹400–800 a month)
```bash
# on the server, with Node 22 installed
npm install -g pm2
pm2 start server.js --name algolens && pm2 save && pm2 startup
```
Put Caddy or Nginx in front for HTTPS on your own domain.

## Settings (.env)

| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | none | Required to open `/admin` |
| `PORT` | 3000 | Web port |
| `SYNC_TIME` | 23:45 | Daily history refresh, India time |
| `LIVE_INTERVAL_MIN` | 15 | Minutes between live refreshes |
| `LIVE_HOURS` | 09:00-23:45 | Window for live refreshes, India time |
| `LIVE_WEEKENDS` | no | Set to `yes` to refresh on Saturday and Sunday too |
| `SYNC_DELAY_MS` | 1500 | Pause between Tradetron requests |
| `TRADETRON_COOKIE` | none | Optional. The admin page is the easier way to set it |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | none | Optional failure alerts |

## Before you go public

- **Permission.** Get each creator's written OK before publishing their numbers.
- **Tradetron.** The collector reads Tradetron's internal web endpoints, not an official API. They can change without notice; if they do, syncs fail and the admin page shows why. Ask Tradetron support whether this use is acceptable, or whether they offer partner access.
- **SEBI.** Publishing strategy returns to attract subscribers can fall under SEBI rules for research analysts and retail algo trading. Take advice from a SEBI-aware lawyer or CA before marketing performance.
