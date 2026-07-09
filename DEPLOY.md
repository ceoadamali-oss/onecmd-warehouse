# Deploy checklist — onecmd-warehouse

## Vercel environment variables (required for live photo/gallery + receive sync)

Add these in **Vercel → onecmd-warehouse → Settings → Environment Variables** for Production, Preview, and Development:

| Variable | Value |
|----------|--------|
| `VITE_SUPABASE_URL` | `https://gqapwytzpwpvwahfdeom.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | *(from Supabase → Project Settings → API)* |
| `VITE_SUPABASE_SERVICE_ROLE_KEY` | *(from Supabase → Project Settings → API — keep secret)* |

After saving, **Redeploy** the latest `main` branch.

## Customer site gallery API

On **atk-custom-site** Vercel project, add the same `VITE_SUPABASE_URL` and `VITE_SUPABASE_SERVICE_ROLE_KEY`, then redeploy.

## Premises lock behavior

- **Technicians & staff**: app locks off authorized shop locations. No distance or radius is shown in the UI.
- **Super Admin**: no premises lock — full access from anywhere.
- **Local dev bypass** (dev only): set `VITE_GEOFENCE_DEV_BYPASS=true` in `.env`.

## Super Admin login

- Login mode: **Super Admin**
- Password: `111` or `adam2026`

## Verify after deploy

1. Super Admin can log in and use the app from any location.
2. Technician PIN login is blocked off-premises with a generic "App Locked" screen.
3. Product Photo Studio and Build Gallery Studio uploads work (no "Server database configuration missing").
4. Receive inventory saves and stays on the intake screen.
