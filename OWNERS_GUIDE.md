# IronScout — Owner's Guide

Plain-English notes for whoever runs this. No coding needed for anything on this page.

Site: **https://ironscout-jbgv.onrender.com**
Code: **https://github.com/ehrhard82/Ironscout** (every change pushed here goes live in ~3 minutes)

---

## What the site does, in one paragraph

Every day it pulls live listings for each tracked machine from GovDeals and IronPlanet
(and Ritchie Bros when switched on), and once a week it pulls what those machines
*actually sold for*. It works out a market value for each machine (sold prices when there
are enough, asking prices otherwise), flags live listings that are well under it after
auction fees, scores them, and emails/texts subscribers about the ones that match their
settings. Users type a machine on the home page and see all of that on one screen.

## The pages

| Page | Who sees it | What it's for |
|---|---|---|
| `/` Deals | everyone | Type a machine → market value, recent sales, deals. Typing a machine we don't track yet starts a fetch on the spot (2–5 min). |
| `/mine.html` | everyone | Deals across all the machines on your watchlist. |
| `/account.html` Settings | everyone | Machines to get alerts for, states, % and $ thresholds, email/text, how often. |
| `/broker.html` Broker board | admin + broker | Deals to work (claim / pass / mark sold, commission tracking) and the **buyer book**: add buyers and what they want; matching deals say "2 buyers want this" on the card and come first in alert emails. |
| `/admin.html` | admin | Fetch a machine now, fetch sold prices, re-score, test the sources, see recent runs, manage users. |

## Daily routine (once the timers are set up, this is automatic)

Nothing. The scheduler fetches every morning and alerts go out on each user's schedule.
Glance at `/admin.html` once a week: every run in "Recent ingest runs" should say
`SUCCEEDED` with a fetched count. A red error line tells you what broke in plain words.

## Setting up the timers (do once — the free host can't run its own clock)

1. Go to **cron-job.org**, make a free account, click **Create cronjob**.
2. Job 1 — *IronScout ingest*
   URL: `https://ironscout-jbgv.onrender.com/api/cron/ingest?key=k7Qm2vX9pL4nR8tW3zB6yH1sD5fG0jN`
   Schedule: every day at 6:00 AM.
3. Job 2 — *IronScout alerts*
   URL: `https://ironscout-jbgv.onrender.com/api/cron/alerts?key=k7Qm2vX9pL4nR8tW3zB6yH1sD5fG0jN`
   Schedule: every 15 minutes. (Also keeps the site awake so it loads instantly.)
4. If a job ever shows failures, open the URL in Safari — it should say `{"started":true}`.

The key above is the `CRON_SECRET` in Render → ironscout-jbgv → Environment. If you
change it there, change it in both jobs.

## Adding people

- **Your broker:** `/admin.html` → Users → create account with role **broker**, or let him
  sign up and change his role in the dropdown. Brokers don't pay.
- **A paying customer:** they sign up themselves; once Stripe is connected they get a trial
  and then pay. Until Stripe is set up, use **Comp 1 yr** on their row to let them in free.

## Switching things on later (each one is just env vars in Render → Environment)

| Want | Where to get it | Env vars |
|---|---|---|
| Ritchie Bros listings | already built — costs more Apify credit | `APIFY_SOURCES` = `govdeals,ironplanet,rbauction` |
| Machinio dealer listings (asking prices) | cheap (~$1.50 per 1,000) | add `machinio` to `APIFY_SOURCES` |
| eBay | developer.ebay.com (free, ~1 day approval) | `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET` |
| Real emails | resend.com (free up to 3,000/mo; verify your domain) | `RESEND_API_KEY`, `MAIL_FROM` |
| Text messages | twilio.com (~$1.15/mo + per text; US needs a short business registration) | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` |
| Taking money | stripe.com — the recipe is at the top of `routes/billing.js` | `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` |
| Your own domain | any registrar → Render → Settings → Custom Domains | update `APP_URL` |

Render redeploys itself whenever you save env vars. Edit mode: tap **Edit**, trash the row,
**Add**, type key and value, **Save, rebuild, and deploy**.

## What it costs

- Render web service: **$0** (free tier; sleeps when idle — the alerts timer keeps it awake).
- Neon database: **$0** up to 500 MB. Tens of thousands of listings fit.
- Apify: **pay per listing fetched**, roughly $1.50–3 per 1,000. Each daily fetch pulls up to
  300 listings per source per machine. 8 machines × 2 sources × 300 = ~4,800 listings a day
  worst case. Check **apify.com → Billing** after the first week and, if it's more than you
  like, lower `maxItems` in `lib/sources/apify.js` or track fewer machines.
- Everything else is $0 until you turn it on.

## When something looks wrong

| Symptom | Check |
|---|---|
| Site won't load / "server error" | `https://ironscout-jbgv.onrender.com/health` — should say `"status":"ok"`. If it says `db error`, the Neon database string in Render is wrong or Neon is paused. |
| A machine shows no listings | `/admin.html` → type the machine → **Test sources now**. ✅ means the scrapers work; ❌ shows the reason. |
| Fetch runs say `interrupted` | A redeploy happened mid-fetch. Just fetch again. |
| Fetch runs say `402` or `not authenticated` | `APIFY_TOKEN` in Render is missing or has a typo. |
| "N closed items, 0 with a final price" on a `:sold` run | The scraper changed its field names. Open `/api/admin/debug/source?name=govdeals&q=wheel%20loader&mode=sold` and send the `keys` list to whoever maintains the code. |
| Deals look wrong | Hit **Recalculate deals** on `/admin.html` after any change. Units marked inoperable / parts / salvage are excluded on purpose. Anything >60% under market is tagged "verify". |

## How "market value" and "deal" are decided (so you can explain it to a skeptic)

1. **Market value** = the middle (median) price of comparable units: same state and model-year
   band if there are at least 5, widening to national and wider year bands until there are.
   Completed **sales** from the last 120 days are used when there are at least 5; otherwise
   firm asking prices (fixed-price listings and auctions in their final 24 hours).
2. **A deal** is a live listing at least 5% under that value with at least $2,500 of profit
   left after fees (3% transaction allowance; 12% buyer's premium on auction lots).
3. **Auctions with more than 3 days left are never deals** — a current bid isn't a price.
   Inside 3 days the score is weighted by time left.
4. **Score 0–10** blends % off, dollars on the table, how many comparables backed it, and
   time left. Each subscriber's own settings (states, min %, min $) filter on top.

Settings that control all of this live in Render → Environment (`DEAL_THRESHOLD_PERCENT`,
`MIN_DEAL_DOLLARS`, `BUYER_PREMIUM_PERCENT`, `AUCTION_MAX_HOURS`, and friends — see `.env.example`).

## Handing it to another server

`DEPLOY.md` section B. The whole thing is one Node app plus one Postgres database; nothing
here is tied to Render or Neon.
