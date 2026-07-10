# Deploy checklist — onecmd-warehouse

## Vercel environment variables (required for live photo/gallery + receive sync)

Add these in **Vercel → onecmd-warehouse → Settings → Environment Variables** for Production, Preview, and Development:

| Variable | Value |
|----------|--------|
| `VITE_SUPABASE_URL` | `https://gqapwytzpwpvwahfdeom.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | *(from Supabase → Project Settings → API)* |
| `VITE_SUPABASE_SERVICE_ROLE_KEY` | *(from Supabase → Project Settings → API — keep secret)* |
| `SESSION_JWT_SECRET` | Random string, **min 32 characters** — signs staff session tokens |
| `ADMIN_PASSWORD` or `SUPER_ADMIN_PASSWORD` | Super Admin login password (not hardcoded in app) |
| `TECHNICIAN_PINS_JSON` | *(Optional bootstrap)* Legacy JSON array of technician PINs. New staff registered via Access Governance are stored in Supabase and work for login automatically. |
| `RESEND_API_KEY` | *(Optional)* Sends onboarding PIN emails. Without it, registration still succeeds and the PIN is shown on screen. |
| `OPENAI_API_KEY` | OpenAI API key for sticker/sidewall/stack AI parsing |

After saving, **Redeploy** the latest `main` branch.

## Customer site gallery API

On **atk-custom-site** Vercel project, add the same `VITE_SUPABASE_URL` and `VITE_SUPABASE_SERVICE_ROLE_KEY`, then redeploy.

## Premises lock behavior

- **Technicians & staff**: app locks off authorized shop locations. No distance or radius is shown in the UI.
- **Super Admin**: no premises lock — full access from anywhere.
- **Local dev bypass** (dev only): set `VITE_GEOFENCE_DEV_BYPASS=true` in `.env`.

## Staff authentication

- Login calls `/api/staff-auth` and stores a JWT in `sessionStorage` (tab session).
- Protected API routes require `Authorization: Bearer <token>`.
- Super Admin geofence bypass is derived from the JWT `SUPER_ADMIN` role — not from request body.

### Super Admin login

- Login mode: **Super Admin**
- Password: value of `ADMIN_PASSWORD` or `SUPER_ADMIN_PASSWORD` env var

### Technician login

- Login mode: **Technician**
- PIN: must match a staff profile in Supabase (`CONFIG-EMPLOYEES` row) or legacy `TECHNICIAN_PINS_JSON`

### Registering staff (Super Admin)

1. Log in as **Super Admin** (uses `ADMIN_PASSWORD`).
2. Open **Access Governance** from the dashboard.
3. Fill in Name + Email, then click **Register & Email Onboarding PIN**.
4. The server saves the profile to Supabase and emails the 4-digit PIN (or shows it on screen if email is not configured).
5. The new technician can log in immediately with that PIN — no manual env update needed.

Staff profiles are stored in Supabase `tires_catalog` row `sku = 'CONFIG-EMPLOYEES'` inside the `location_counts.technicians[]` JSON array.

## Local development

Run **`npm run dev`** (starts `vercel dev`, which serves both the Vite UI and `/api/*` routes). Plain `npm run dev:vite` does **not** expose API routes - Super Admin login will fail with a 404.

Add to `.env` (server-side vars are read by `vercel dev` / API routes):

```
SESSION_JWT_SECRET=dev-only-session-secret-change-before-production!!
ADMIN_PASSWORD=your-local-admin-password
TECHNICIAN_PINS_JSON=[{"pin":"1234","id":"tech-ali","name":"Ali Baba"}]
OPENAI_API_KEY=sk-...
```

## Verify after deploy

1. Super Admin can log in and use the app from any location.
2. Technician PIN login is blocked off-premises with a generic "App Locked" screen.
3. Product Photo Studio and Build Gallery Studio uploads work (no "Server database configuration missing").
4. Receive inventory saves and stays on the intake screen.
5. Offline sync and transaction edit/undo/verify require a valid staff session token.
