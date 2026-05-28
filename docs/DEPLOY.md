# deploy — Vercel (cached demo)

**What deploys:** the **cached demo** — the feed and all investigations replay from committed
snapshots (`lib/state/demo-insights.json`, `lib/state/demo-investigations.json`) with **no auth,
no Anthropic key, no database**. This is the shareable public demo.

**What does NOT run on Vercel (run these locally instead):** the *live* briefing, the query box,
and first-time (uncached) investigations. They need Bloomreach OAuth + an Anthropic key, and a live
investigation takes ~115s — over Vercel's 60s function limit. The serverless OAuth would also need a
shared session store (KV/Redis) instead of the local in-memory/file one. So: **demo the live features
locally; deploy the cached demo for a shareable URL.**

## Steps (Vercel git integration — zero config)

1. Vercel dashboard → **Add New… → Project → Import** `rlynjb/blooming_insights`.
2. Framework auto-detects as **Next.js** — leave build settings default. Deploy.
3. Add one **Environment Variable**, then redeploy:
   - `NEXT_PUBLIC_DEMO_ONLY=1` — serves the cached briefing at the root URL and hides the live query box.
   - (optional) `NEXT_PUBLIC_APP_NAME="blooming insights"`.
4. Open the preview URL — the root `/` shows the cached feed; clicking any card replays its cached
   investigation (~6s, animated). Every push to `main` gets its own preview URL.

CLI alternative: `npx vercel` (runs `vercel login` first — interactive, your account), then add the
env var with `npx vercel env add NEXT_PUBLIC_DEMO_ONLY` and `npx vercel --prod`.

## Going fully live on Vercel later (not recommended for hobby tier)

Would require, in addition: a KV/Redis provider (rework `lib/mcp/auth.ts`'s in-memory/file store to
KV so OAuth survives serverless cold starts), `ANTHROPIC_API_KEY` + `APP_ORIGIN` + the Bloomreach
OAuth redirect URI re-registered for the deploy origin, and **Vercel Pro** (or a background-job
architecture) for the >60s investigation latency. The latency wall makes live investigations
impractical on hobby tier regardless of KV — keep live features local.
