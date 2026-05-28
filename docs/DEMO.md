# blooming insights — demo runbook

A 90-second demo of the transparent multi-agent analyst, tuned to what's actually built.

---

## what's cached vs live (read first)

| surface | mode | needs creds / network? |
|---|---|---|
| **feed** (`/?demo=cached`) | cached snapshot | **no** — fully offline |
| **click any card → investigation** | cached replay (~6s, animated) | **no** — all 6 cards pre-cached, no auth/Anthropic |
| **query box** (bottom of feed) | **LIVE** | **yes** — needs the dev server + auth + an Anthropic balance + connectivity |

So the **feed + investigations are wifi-off safe**. The **query box is the one live piece** — only demo it with connectivity (and a valid Anthropic balance). If offline, skip the query step or pre-record it.

Run locally: `npm run dev`, then open **`http://localhost:3000/?demo=cached`**. (Not deployed — a full live investigation is ~115s, over Vercel's 60s limit; the cached path is the demo path.)

---

## pre-flight (do 30 min before, per the spec)

- [ ] `npm run dev` running; open `http://localhost:3000/?demo=cached` and confirm cards render.
- [ ] Click the **hero card** ("usa purchase_revenue · -58.3%") once — confirm the investigation animates in (pipeline lights diagnostic→recommendation, diagnosis + 3 rec cards). Pre-warms nothing (it's cached) but confirms it works.
- [ ] If demoing the query box: confirm Anthropic has credits and run one query end-to-end (~35s).
- [ ] Dedicated clean Chrome profile, no extensions; hide bookmarks/dock/menubar; zoom 110–125%.
- [ ] Mac display → 1080p; dark mode OS + app; quit Slack/email/notifiers; full-screen the browser.
- [ ] Phone hotspot ready as backup (only matters for the live query step).
- [ ] Do one dry run **with wifi off** to prove feed + investigations work offline.

---

## the 90-second script

1. **(0:00)** Open `/?demo=cached`. Feed loads instantly — 5–6 insight cards fade up.
   > *"Ecommerce teams spend hours in dashboards figuring out what just happened. blooming insights does it for them — here's this morning's briefing."*

2. **(0:12)** Point at the top card — **`usa purchase_revenue · -58.3%`** (coral/critical dot).
   > *"The biggest change: US purchase revenue dropped 58%. Let's investigate."*

3. **(0:18)** Click it → the investigation streams in. The **agent-pipeline pill** lights `diagnostic` (purple, pulsing); reasoning thoughts and **EQL tool calls** appear live in the trace.
   > *"You're watching the diagnostic agent reason — it forms hypotheses and queries the workspace through MCP to test each. Every tool call is visible. No black box."*

4. **(0:40)** The **diagnosis** card fills in (center).
   > *"It concluded: the drop is USA-specific — $116k down to $48k — while the UK and Germany held. Not a global problem."*

5. **(0:55)** The pipeline advances to `recommendation` (amber); **3 recommendation cards** fade in (right).
   > *"And it hands off to the recommendation agent — three concrete actions, each tied to a real Bloomreach feature: a re-engagement segment, a win-back campaign, and a data-health monitoring scenario. With steps and impact estimates."*

6. **(1:10)** Type in the **query box** (bottom): *"which countries had the most purchase revenue?"* → the answer streams in, pinned at the top.
   > *"And you can just ask. It classifies the question, queries live, and answers — UK is now the #1 market, up 12%."*  *(skip if offline)*

7. **(1:25)** Close.
   > *"Every other AI analyst hides its reasoning. blooming insights shows you exactly why it reached each conclusion — and it's the only one built MCP-native on Bloomreach."*

(Optional flourish: hit **`export ↓`** on the investigation — *"…and you can export the full reasoning trace.*")

---

## the pitch (bookends)

- **Open (1 sentence):** *"Ecommerce teams spend hours in dashboards trying to figure out what just happened in their store."*
- **Demo:** the 90 seconds above.
- **Close:** *"Every other AI analyst hides its reasoning. blooming insights shows its work — and it's the only one built MCP-native on Bloomreach."*

Don't show the architecture diagram unless asked. If asked: coordinator → monitoring / diagnostic / recommendation specialists, all over the loomi connect MCP, reasoning streamed to the UI.

---

## anticipated judge questions (one-sentence answers)

- **"How is this different from Conjura / Graas / Owly?"** → *"Transparent reasoning plus MCP-native to Bloomreach — we show our work, they don't."*
- **"Is it making real queries or is this canned?"** → *"Real — it runs EQL through the live loomi MCP; what you're seeing replayed is a real recorded run. Here's a live one [the query box]."*
- **"What if the data is sparse / weird numbers?"** → *"The agents anchor to the workspace's active window and say so honestly when data is inconclusive rather than inventing it — you saw it reason about exactly that."*
- **"What would you build next?"** → *"Write-path actions via the REST API (one-click apply the recommendations), multi-workspace support, and an evaluation harness for agent quality."*
- **"Does it scale / how fast?"** → *"The MCP server rate-limits to ~1 req/sec per workspace, so we cache aggressively and the demo replays instantly; production would run briefings on a schedule and cache investigations."*

---

## known limitations (be ready, don't volunteer)

- **Latency:** a full *live* investigation is ~115s (1 req/sec MCP × many EQL calls + two agents). The demo uses cached replays (~6s). Mention only if asked about speed.
- **Data recency:** the `wobbly-ukulele` sandbox has no last-7-day activity, so the monitoring feed's period-over-period numbers are historical/illustrative; the agents detect this and anchor to the populated window (the query box answer shows real 90/180-day numbers).
- **Single workspace, read-only**, in-memory state (no DB) — by design for the hackathon scope.

---

## contingencies

- **Wifi dies:** the feed + all 6 investigations are cached and offline-safe; just skip the live query step.
- **Anthropic balance runs out:** same — feed + investigations still work (cached, no API calls); only the query box needs the API.
- **Dev server hiccups:** `npm run dev` again; the cached data is on disk (`lib/state/demo-*.json`), nothing to regenerate.

---

## practice

Run the full 90 seconds ≥5 times. Time it. Rehearse the transitions ("now let me show you…"). A rougher product demoed confidently beats a polished one fumbled.
