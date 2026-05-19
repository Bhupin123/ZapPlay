# ZapPlay — Complete Deployment Guide
> Professional, secure, production-ready

---

## Step 1 — Run the Database Schema

1. Go to [supabase.com](https://supabase.com) → your **zapplay** project
2. Click **SQL Editor** in the left sidebar
3. Click **New Query**
4. Open `supabase/schema.sql` from this project
5. Copy the entire contents and paste into the SQL editor
6. Click **Run**

You should see: `Success. No rows returned`

---

## Step 2 — Set Your Admin Account

After you sign up on the live site, make yourself admin:

```sql
update public.profiles
set is_admin = true
where id = (
  select id from auth.users where email = 'YOUR_EMAIL_HERE'
);
```

Run this in the Supabase SQL Editor.

---

## Step 3 — Configure Supabase Auth

Go to **Authentication → Settings** in Supabase:

1. **Site URL**: `https://your-app.vercel.app` (update after deploy)
2. **Redirect URLs**: add `https://your-app.vercel.app`
3. **Email confirmations**: Enable
4. **Rate limits**:
   - Email signups: `3 per hour`
   - Password resets: `3 per hour`
   - OTP verification: `5 per hour`

---

## Step 4 — Get Your Keys

Go to **Settings → API Keys** in Supabase:

| Key | Where to find it | Used in |
|-----|-----------------|---------|
| Project URL | Top of API page | `.env.local` |
| Anon key | Legacy tab | `.env.local` + `app.js` |
| Service role key | Legacy tab → Secret | `.env.local` ONLY |

---

## Step 5 — Fill in .env.local

Open `.env.local` and replace the placeholders:

```env
SUPABASE_URL=https://smcgjbixbcbkdctnps.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
ADMIN_EMAILS=youremail@gmail.com
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Also open `public/app.js` and replace line 14:
```js
const SUPABASE_ANON = 'eyJhbGci...YOUR_ANON_KEY';
```

---

## Step 6 — Deploy to Vercel

### First time setup:

```bash
# 1. Install Vercel CLI (if not already installed)
npm install -g vercel

# 2. Open terminal in the zapplay-pro folder
cd zapplay-pro

# 3. Login to Vercel
vercel login

# 4. Deploy (follow the prompts)
vercel

# Answer the prompts:
# Set up and deploy? → Y
# Which scope? → your account
# Link to existing project? → N
# Project name? → zapplay
# Directory? → ./  (press Enter)
# Override settings? → N
```

### Add environment variables to Vercel:

```bash
vercel env add SUPABASE_URL
# paste: https://smcgjbixbcbkdctnps.supabase.co

vercel env add SUPABASE_ANON_KEY
# paste your anon key

vercel env add SUPABASE_SERVICE_KEY
# paste your service role key

vercel env add ADMIN_EMAILS
# paste your email

vercel env add NEXT_PUBLIC_APP_URL
# paste your vercel URL e.g. https://zapplay.vercel.app
```

### Deploy to production:

```bash
vercel --prod
```

Your site is now live at `https://zapplay.vercel.app` (or your custom domain)

---

## Step 7 — Update Supabase Auth URLs

After you get your Vercel URL, go back to Supabase:

**Authentication → URL Configuration**:
- Site URL: `https://zapplay.vercel.app`
- Redirect URLs: `https://zapplay.vercel.app`

---

## Step 8 — Custom Domain (Optional)

1. Buy a domain from [Namecheap](https://namecheap.com) (~$10/year)
2. In Vercel dashboard → your project → **Settings → Domains**
3. Add your domain
4. Follow Vercel's DNS instructions (add CNAME record in Namecheap)
5. Update Supabase Auth URLs to your custom domain

---

## Step 9 — Google AdSense

1. Apply at [adsense.google.com](https://adsense.google.com)
2. Add your site URL
3. Wait for approval (1-14 days)
4. Once approved, replace the ad slots in `index.html`:

```html
<!-- Replace this: -->
<div class="ad">...</div>

<!-- With your AdSense code: -->
<ins class="adsbygoogle"
     style="display:block"
     data-ad-client="ca-pub-XXXXXXXXXXXXXXXX"
     data-ad-slot="XXXXXXXXXX"
     data-ad-format="auto">
</ins>
<script>(adsbygoogle = window.adsbygoogle || []).push({});</script>
```

---

## Security Checklist ✅

- [x] Service role key only in Vercel env vars (never in browser)
- [x] RLS enabled on all tables
- [x] Server-side input validation in every API route
- [x] Server-side rate limiting per IP per endpoint
- [x] JWT verified server-side on every protected route
- [x] Security headers (CSP, HSTS, X-Frame-Options) in vercel.json
- [x] Refresh tokens stored in sessionStorage (tab-scoped, not persistent)
- [x] Access tokens stored in memory only
- [x] Password strength validation
- [x] Email enumeration prevention on forgot password
- [x] Username format validation (alphanumeric + underscore only)
- [x] Admin role checked server-side (not just frontend)
- [x] .gitignore protects .env files
- [x] Atomic play count increment (no race conditions)

---

## Architecture Summary

```
Browser (index.html + app.js)
  │  No secrets. Talks only to /api/*
  │  Realtime via Supabase WebSocket (read-only)
  │
  ▼
Vercel Edge Functions (/api/*.js)
  │  Validates JWT server-side
  │  Rate limits by IP
  │  Sanitizes all input
  │  Uses SUPABASE_SERVICE_KEY (secret, never exposed)
  │
  ▼
Supabase (PostgreSQL)
  │  RLS policies on every table
  │  Realtime publications for live updates
  │  Auth handled natively
```

---

## Useful Commands

```bash
# Run locally
vercel dev

# Deploy to preview
vercel

# Deploy to production
vercel --prod

# View logs
vercel logs

# Add env variable
vercel env add VARIABLE_NAME

# List env variables
vercel env ls
```

---

## Need Help?

- Supabase docs: https://supabase.com/docs
- Vercel docs: https://vercel.com/docs
- Supabase Discord: https://discord.supabase.com
