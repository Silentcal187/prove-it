# Prove It Supabase Web V9

Version 9 adds:

- Automatic final verdict calculation
- Profile page with clout display
- Source-domain scoring
- Moderator evidence review dashboard
- Comment-vote clout and 12-hour cooldown logic
- Popularity-based shorter voting windows

## Upgrade steps

1. Open Supabase.
2. Go to SQL Editor.
3. Run `04_v9_upgrade.sql` once.
4. Replace the existing website files in GitHub with this version.
5. Keep your real Supabase values inside `config.js`.
6. Wait for Vercel to redeploy.
7. Test the live site.

## Making yourself admin

In Supabase Table Editor:

1. Open `profiles`.
2. Find your user row.
3. Change `role` from `member` to `admin`.
4. Save.

After that, the Moderator Dashboard will show evidence review and source-domain scoring controls.

## Final verdict rules

A claim can become:

- `proven_with_evidence`
- `disproven_with_evidence`
- `additional_evidence_required`
- `under_reassessment`

The function checks:

- Weighted Agree / Disagree / Needs Evidence votes
- Supporting evidence score
- Opposing evidence score
- Context evidence score
- Minimum vote count
- Whether the voting window has ended

Moderators/admins can use the “close + calculate” button for testing.

## AI worker note

This version has AI review placeholders and moderator review tools. The real AI evidence-checking worker should be added next as a server-side function so private API keys are never exposed in the frontend.
