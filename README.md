# Prove It Supabase Website - Version 8

This version connects the Prove It website to your Supabase database.

## Files

- `index.html` - main website
- `styles.css` - design
- `supabase-app.js` - Supabase-connected app logic
- `config.js` - paste your Supabase URL and anon public key here

## Setup

1. Open `config.js`.
2. Replace:

```js
export const SUPABASE_URL = "PASTE_YOUR_SUPABASE_URL_HERE";
export const SUPABASE_ANON_KEY = "PASTE_YOUR_ANON_PUBLIC_KEY_HERE";
```

with your real Supabase Project URL and anon public key.

Example:

```js
export const SUPABASE_URL = "https://your-project-id.supabase.co";
export const SUPABASE_ANON_KEY = "your-long-anon-public-key";
```

Do not use your service_role key.

## Important local testing note

Because this website uses JavaScript modules, it should be opened through a local server, not just double-clicked.

The easiest way with VS Code:

1. Open the folder in VS Code.
2. Install the Live Server extension if needed.
3. Right-click `index.html`.
4. Click `Open with Live Server`.

If you use Python:

```bash
python -m http.server 5500
```

Then open:

```text
http://localhost:5500
```

## What works

- Login
- Signup
- Logout
- Load claims from Supabase
- Submit claims
- Vote Agree / Disagree / Needs Evidence
- Submit evidence
- Submit comments
- Vote Agree / Disagree on comments
- Appeal settled claims and call the 51% reassessment function

## Next improvements

- Add automatic final verdict calculation
- Add AI evidence checking worker
- Add source-domain scoring
- Add moderator dashboard
- Add user profile page and clout display
- Deploy to Vercel
