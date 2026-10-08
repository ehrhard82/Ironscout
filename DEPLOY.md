# Deploying IronScout

Two paths. Start with **A** (free) to prove it with your broker; move to **B**
(~$12–20/month) once anyone is paying.

---

## A. Free: Render + Neon + cron-job.org  ($0/month)

What you get: a public HTTPS site, a real Postgres database, daily fetching and
alerts. What you give up: the site **sleeps after 15 idle minutes** and takes
about a minute to wake on the next visit (Render shows a loading page), and
Render's own docs say not to use the free tier for production. That's fine for
"my broker and I are testing this." It is not fine once strangers pay you.

### 1. Put the code on GitHub (5 min)
Create a free GitHub account and a new **private** repository called `ironscout`.
Upload the contents of the archive (drag and drop works on github.com, or
`git init && git add . && git commit -m init && git push`). **Never upload your
`.env` file** — it's in `.gitignore` for that reason.

### 2. Database on Neon (5 min)
1. neon.tech → sign up (no card) → New project → name it `ironscout`, region
   US East.
2. Copy the **connection string** (starts `postgres://…neon.tech/…?sslmode=require`).
   That is your `DATABASE_URL`.
3. Free limits: 500 MB storage, 100 compute-hours/month, then it pauses till
   next month. A few thousand listings is a few MB; you'll be fine for a long time.

### 3. Web service on Render (10 min)
1. render.com → sign up (GitHub login) → **New → Blueprint** → pick the `ironscout`
   repo. Render reads `render.yaml` and asks for the env vars.
2. Fill in at minimum:
   - `DATABASE_URL` — from Neon
   - `APP_URL` — `https://ironscout.onrender.com` (or whatever name Render gives you;
     change later when you point your domain at it)
   - leave the Stripe/Resend/eBay/Apify ones blank for now if you don't have them;
     everything still runs on sample data.
3. Deploy. First build takes ~2 minutes. Open the URL; you'll see the login page.
4. **Apply the schema** (once): Render dashboard → your service → **Shell** tab →
   `npm run db:init`. (If the free tier hides the Shell tab, run it from your own
   computer instead: put `DATABASE_URL=…` in a local `.env` and run `npm run db:init`
   there — it connects straight to Neon.)
5. Open the site and **sign up. The first account becomes admin.** Then visit
   `/admin.html`, type `wheel loader`, click **Fetch now**. In a minute, `/` shows deals.

### 4. Scheduler with cron-job.org (5 min)
A sleeping service can't run its own timer, so an outside clock pokes it.
1. In Render → Environment, copy the value of `CRON_SECRET` (the blueprint generated one).
2. cron-job.org → free account → **Create cronjob**:
   - Title `ironscout ingest`, URL `https://YOUR-APP.onrender.com/api/cron/ingest?key=CRON_SECRET`,
     schedule **every day at 6:00** (your timezone). Request timeout: 30 s is fine — the
     endpoint answers immediately and works in the background.
   - Second job `ironscout alerts`, URL `…/api/cron/alerts?key=CRON_SECRET`, **every 15 minutes**.
     This also keeps the service awake during the day, which is what you want.
3. Both URLs return `{"started":true}` when working. Wrong key → 403.

### 5. Your own domain (optional, ~$12/yr)
Buy `ironscout.com`/`.io` wherever. Render → Settings → Custom Domains → add it,
then create the CNAME it tells you to at your registrar. HTTPS is automatic.
Update `APP_URL` to the new domain.

### 6. Turn on the money and the messages (when ready)
- **Stripe**: follow the comment block at the top of `routes/billing.js`. The webhook
  URL is `https://YOUR-DOMAIN/api/billing/webhook`. Paste the three keys into Render's
  Environment tab; it redeploys automatically.
- **Resend** (email): resend.com → add your domain (two DNS records) → API key → `RESEND_API_KEY`
  and `MAIL_FROM=IronScout <alerts@yourdomain.com>`. Until then, "emails" print to Render's logs.
- **Twilio** (texts): twilio.com → buy a number (~$1.15/mo) → `TWILIO_ACCOUNT_SID`,
  `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`. US carriers require a short business registration
  (A2P 10DLC) that Twilio walks you through; until approved, volume is throttled.
- **eBay / Apify**: see README. Blank = sample data.

### Free-tier gotchas, honestly
- First visit after idle = ~1 minute wait. The 15-min alerts cron mostly hides this.
- Render free: 750 instance-hours/month — enough for one always-awake service.
- Neon pauses compute at 100 hours/month of *database* activity; a mostly-idle app
  uses far less. If it ever pauses, the site errors until the 1st of the month or you
  upgrade ($19/mo).
- Render deletes the deploy if the repo is removed; keep the GitHub repo.
- Don't put real customer card data anywhere — you aren't, Stripe hosts the checkout.

---

## B. Paid, always-on: a $12–20/month VPS

When people are paying, run it on a small server that never sleeps.

### Rent a box
Hetzner (CX22, ~€4/mo), DigitalOcean ($12/mo), or Linode. Ubuntu 24.04. Note the IP.

### One-time setup (copy-paste, ~20 min)
```bash
# as root on the server
apt update && apt install -y postgresql nodejs npm caddy git
npm install -g pm2

# database
sudo -u postgres psql -c "CREATE USER ironscout WITH PASSWORD 'CHANGE_ME';"
sudo -u postgres psql -c "CREATE DATABASE ironscout OWNER ironscout;"

# app
adduser --disabled-password --gecos "" app
su - app
git clone https://github.com/YOU/ironscout.git && cd ironscout
npm install --omit=dev
cp .env.example .env && nano .env     # set DATABASE_URL=postgres://ironscout:CHANGE_ME@localhost/ironscout, APP_URL, keys...
npm run db:init
pm2 start server.js --name ironscout
pm2 start scripts/schedule.js --name ironscout-scheduler   # built-in cron: ingest daily, alerts every 15 min
pm2 save && pm2 startup                                     # follow the printed command so it survives reboots
exit
```

### HTTPS with Caddy (automatic certificates)
Point your domain's A record at the server IP, then:
```bash
cat > /etc/caddy/Caddyfile <<EOF
ironscout.com {
    reverse_proxy localhost:3000
}
EOF
systemctl reload caddy
```
That's it — Caddy fetches and renews the certificate itself.

### Updating later
```bash
su - app -c "cd ironscout && git pull && npm install --omit=dev && npm run db:init && pm2 restart all"
```
`db:init` is safe to rerun; the schema uses `IF NOT EXISTS` throughout.

### Backups
Neon/Render handle this on path A. On a VPS, a nightly dump is one cron line:
```
0 3 * * * pg_dump ironscout | gzip > /home/app/backup-$(date +\%u).sql.gz
```

---

## Checklist before you let a stranger pay

- [ ] Stripe in **live** mode (not test keys), webhook verified with a real test purchase
- [ ] Resend domain verified so alerts don't land in spam
- [ ] `APP_URL` is your real domain (it's in every email and Stripe redirect)
- [ ] `/terms.html` and `/privacy.html` filled in (name, state, email) and skimmed by a lawyer
- [ ] Your broker's account set to role **broker** in `/admin.html`
- [ ] You've received at least one real alert email yourself
- [ ] Moved off the free tier, or at peace with the 1-minute wake-up
