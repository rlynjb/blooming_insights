import React, { useState, useRef } from "react";
import {
  TrendingDown, ShoppingCart, Flame, DollarSign, Search, RotateCcw,
  UserMinus, ShieldAlert, PackageX, Megaphone, Check, ArrowRight, AlertTriangle,
} from "lucide-react";

/* ──────────────────────────────────────────────────────────────
   blooming insights — step 1 feed (monitoring) with coverage grid
   the coverage grid sits at the top of col 1, above the categorized
   InsightCards. col 2 is the StatusLog. QueryBox is removed from render.
   ────────────────────────────────────────────────────────────── */

const C = {
  bg: "#0a0e14",
  panel: "#11161e",
  panelHover: "#151c26",
  border: "#1c242e",
  ghost: "#0f141b",
  ghostBorder: "#1f2832",
  callout: "#0d1117",
  text: "#e6edf3",
  dim: "#8b97a3",
  faint: "#566571",
  ghostText: "#3a4651",
  mint: "#34d399",
  coral: "#fb7185",
  amber: "#fbbf24",
  mono: "'JetBrains Mono', ui-monospace, monospace",
  sans: "'Inter', system-ui, sans-serif",
};

const SEV = {
  critical: { c: C.coral, label: "critical" },
  warning: { c: C.amber, label: "warning" },
  positive: { c: C.mint, label: "positive" },
};

// ── all 10 categories for the coverage grid ──
const CATEGORIES = [
  { id: "conversion_drop", icon: TrendingDown, label: "conversion rate drop", coverage: "full", status: "anomaly", severity: "critical", finding: "global conversion −53% vs 90d" },
  { id: "cart_abandonment", icon: ShoppingCart, label: "cart abandonment", coverage: "full", status: "anomaly", severity: "warning", finding: "abandonment +22% at shipping step" },
  { id: "product_demand", icon: Flame, label: "product demand spike", coverage: "full", status: "spike", severity: "positive", finding: "1 product +1233% velocity" },
  { id: "revenue_drop", icon: DollarSign, label: "revenue drop", coverage: "full", status: "anomaly", severity: "critical", finding: "revenue −18%, traffic flat" },
  { id: "customer_churn", icon: UserMinus, label: "customer churn", coverage: "full", status: "clear", finding: "repeat rate stable" },
  { id: "inventory", icon: PackageX, label: "inventory problems", coverage: "limited", finding: "velocity ok · no stock level in catalog" },
  { id: "campaign_perf", icon: Megaphone, label: "campaign performance", coverage: "limited", finding: "traffic ok · no utm source" },
  { id: "search_failure", icon: Search, label: "search failure", coverage: "unavailable", missing: "search" },
  { id: "return_spike", icon: RotateCcw, label: "product return spike", coverage: "unavailable", missing: "return / refund" },
  { id: "fraud", icon: ShieldAlert, label: "fraud detection", coverage: "unavailable", missing: "device / payment signals" },
];

// ── the firing insights → InsightCards (one per anomaly/spike tile) ──
const INSIGHTS = [
  {
    id: "conversion_drop", severity: "critical", category: "conversion rate drop",
    headline: "global conversion_rate · −53%", scope: "global",
    summary: "conversion_rate down 53% vs prior 90 days",
    metric: "conversion_rate", dir: "down", pct: 53, prior: 0.42, now: 0.2,
    why: "the funnel from view → checkout held steady, but checkout → purchase collapsed. card payments are failing silently at the final step while paypal is unaffected — every lost conversion here is a completed-intent customer walking away at the till.",
  },
  {
    id: "revenue_drop", severity: "critical", category: "revenue drop",
    headline: "global purchase_revenue · −18%", scope: "global",
    summary: "revenue down 18% with session volume flat",
    metric: "purchase_revenue", dir: "down", pct: 18, prior: 1.0, now: 0.82,
    why: "traffic is flat (+1%), so this isn't a demand problem — it's conversion. the drop is concentrated on mobile (−31% vs −3% desktop) and average order value is steady, meaning fewer orders, not smaller ones. points squarely at a mobile checkout regression.",
  },
  {
    id: "cart_abandonment", severity: "warning", category: "cart abandonment",
    headline: "global cart_abandonment · +22%", scope: "global",
    summary: "abandonment rising at the shipping-reveal step",
    metric: "cart_abandonment", dir: "up", pct: 22, prior: 0.61, now: 0.74,
    why: "carts fill normally then go cold precisely when shipping cost appears. displayed shipping rose ~35% after the carrier rate update, and coupon-hunting attempts tripled in the same window — shoppers are reacting to sticker shock at checkout.",
  },
  {
    id: "product_demand", severity: "positive", category: "product demand spike",
    headline: "whey-protein-1kg demand · +1233%", scope: "product",
    summary: "one SKU's purchase velocity went vertical",
    metric: "purchase_velocity", dir: "up", pct: 1233, prior: 0.08, now: 1.0,
    why: "a single SKU jumped from ~30 to ~400 sales/day. referral traffic from tiktok is up 38× in the same window with a US/UK skew — almost certainly a creator mention. an opportunity to ride, not a problem to fix: front-page it and protect inventory.",
  },
];

const COVERAGE_NOTE_SKIPPED = ["search failure", "product return spike", "fraud detection"];

const TRACE = [
  { kind: "thought", ts: "19:47:37", text: "reading the workspace schema to see which categories are checkable here." },
  { kind: "thought", ts: "19:47:39", text: "7 of 10 categories supported; skipping search, returns, fraud — those events aren't emitted." },
  { kind: "thought", ts: "19:47:42", text: "running each category recipe as 90d vs prior 90d. batching to stay within my query budget." },
  { kind: "tool", ts: "19:47:44", tool: "execute_analytics_eql", ms: 870 },
  { kind: "thought", ts: "19:47:45", text: "conversion_rate −53% — clears the critical threshold. checkout→purchase is where it breaks." },
  { kind: "tool", ts: "19:47:46", tool: "execute_analytics_eql", ms: 612 },
  { kind: "thought", ts: "19:47:48", text: "purchase_revenue −18% with flat sessions; cart_abandonment +22%. flagging both." },
  { kind: "tool", ts: "19:47:49", tool: "execute_analytics_eql", ms: 744 },
  { kind: "thought", ts: "19:47:51", text: "one SKU shows +1233% velocity — surfacing as a positive anomaly." },
];

/* ── small bits ── */
function Dot({ color, pulse, size = 7 }) {
  return (
    <span style={{ position: "relative", display: "inline-flex", width: size, height: size }}>
      <span style={{ width: size, height: size, borderRadius: 99, background: color }} />
      {pulse && <span style={{ position: "absolute", inset: 0, borderRadius: 99, background: color,
        animation: "ping 1.8s cubic-bezier(0,0,.2,1) infinite" }} />}
    </span>
  );
}

/* ── coverage grid tile ── */
function Tile({ cat, onPick, dimmed }) {
  const [hover, setHover] = useState(false);
  const Icon = cat.icon;

  if (cat.coverage === "unavailable") {
    return (
      <div title={`needs ${cat.missing} — not in this workspace`}
        style={{ display: "flex", flexDirection: "column", gap: 8, padding: 13, borderRadius: 11,
          background: C.ghost, border: `1px dashed ${C.ghostBorder}`, minHeight: 98,
          opacity: 0.55, transition: "opacity .18s" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ display: "grid", placeItems: "center", width: 26, height: 26, borderRadius: 7,
            border: `1px dashed ${C.ghostBorder}` }}><Icon size={13} color={C.ghostText} /></span>
          <span style={{ fontFamily: C.mono, fontSize: 8.5, color: C.ghostText, letterSpacing: ".06em" }}>no data source</span>
        </div>
        <div style={{ fontFamily: C.mono, fontSize: 11, color: C.faint }}>{cat.label}</div>
        <div style={{ marginTop: "auto", fontFamily: C.mono, fontSize: 9, color: C.ghostText }}>
          planned · needs <span style={{ color: C.faint }}>{cat.missing}</span>
        </div>
      </div>
    );
  }

  const firing = cat.status === "anomaly" || cat.status === "spike";
  const accent = cat.coverage === "limited" ? C.amber : firing ? SEV[cat.severity].c : C.mint;
  const statusLabel = cat.coverage === "limited" ? "limited"
    : cat.status === "anomaly" ? "anomaly" : cat.status === "spike" ? "spike" : "clear";

  return (
    <div
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onClick={() => firing && onPick(cat.id)}
      style={{ display: "flex", flexDirection: "column", gap: 8, padding: 13, borderRadius: 11,
        background: hover && firing ? C.panelHover : C.panel, minHeight: 98,
        border: `1px solid ${hover && firing ? accent + "66" : C.border}`,
        transition: "all .16s", position: "relative", overflow: "hidden",
        cursor: firing ? "pointer" : "default", opacity: dimmed ? 0.4 : 1 }}>
      {firing && <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: accent, opacity: hover ? 1 : 0.55 }} />}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ display: "grid", placeItems: "center", width: 26, height: 26, borderRadius: 7,
          background: accent + "1a", border: `1px solid ${accent}33` }}><Icon size={13} color={accent} /></span>
        <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <Dot color={accent} pulse={cat.severity === "critical"} size={6} />
          <span style={{ fontFamily: C.mono, fontSize: 9, color: accent, letterSpacing: ".03em" }}>{statusLabel}</span>
        </span>
      </div>
      <div style={{ fontFamily: C.mono, fontSize: 11, color: C.text }}>{cat.label}</div>
      <div style={{ marginTop: "auto", fontFamily: C.sans, fontSize: 10.5, color: C.dim, lineHeight: 1.35 }}>{cat.finding}</div>
    </div>
  );
}

/* ── insight card ── */
function InsightCard({ ins, highlight, cardRef }) {
  const [hover, setHover] = useState(false);
  const sev = SEV[ins.severity];
  const arrow = ins.dir === "up" ? "▲" : "▼";
  return (
    <div ref={cardRef}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ borderRadius: 14, background: C.panel, padding: 20, position: "relative",
        border: `1px solid ${highlight ? sev.c : hover ? C.border : C.border}`,
        boxShadow: highlight ? `0 0 0 1px ${sev.c}, 0 10px 40px -16px ${sev.c}55` : "none",
        transition: "all .25s" }}>
      {/* header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <Dot color={sev.c} pulse={ins.severity === "critical"} />
            <span style={{ fontFamily: C.mono, fontSize: 12, color: sev.c, letterSpacing: ".06em", textTransform: "uppercase" }}>{sev.label}</span>
          </span>
          {/* NEW category chip */}
          <span style={{ fontFamily: C.mono, fontSize: 10, color: C.dim, padding: "3px 9px", borderRadius: 99,
            background: C.callout, border: `1px solid ${C.border}` }}>{ins.category}</span>
          <span style={{ fontFamily: C.mono, fontSize: 11, color: C.faint }}>· started ~0 days ago</span>
        </div>
        <span style={{ fontFamily: C.mono, fontSize: 11, color: C.faint }}>via execute_analytics_eql</span>
      </div>

      {/* headline + summary */}
      <div style={{ fontFamily: C.mono, fontSize: 21, color: C.text, letterSpacing: "-.01em", marginBottom: 8 }}>{ins.headline}</div>
      <div style={{ fontFamily: C.mono, fontSize: 13, color: C.dim }}>{ins.summary}</div>

      <div style={{ height: 1, background: C.border, margin: "16px 0" }} />

      {/* metric comparison */}
      <div style={{ fontFamily: C.mono, fontSize: 12, color: C.dim, marginBottom: 12 }}>
        {ins.metric} · <span style={{ color: sev.c }}>{arrow} {ins.pct}%</span> vs prior 90 days (relative)
      </div>
      <Bar label="prior" value={ins.prior} color={C.faint} />
      <Bar label="now" value={ins.now} color={sev.c} delta={`${arrow} ${ins.pct}%`} />
      <div style={{ marginTop: 12, marginBottom: 16 }}>
        <span style={{ fontFamily: C.mono, fontSize: 11, color: C.faint, marginRight: 9 }}>scope</span>
        <span style={{ fontFamily: C.mono, fontSize: 11, color: C.dim, padding: "3px 10px", borderRadius: 99,
          background: C.callout, border: `1px solid ${C.border}` }}>{ins.scope}</span>
      </div>

      {/* why it matters */}
      <div style={{ borderLeft: `2px solid ${C.amber}`, background: C.callout, borderRadius: "0 8px 8px 0",
        padding: "13px 15px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 7 }}>
          <AlertTriangle size={12} color={C.amber} />
          <span style={{ fontFamily: C.mono, fontSize: 11, color: C.amber, letterSpacing: ".03em" }}>why it matters</span>
        </div>
        <div style={{ fontFamily: C.sans, fontSize: 13, color: C.text, lineHeight: 1.55 }}>{ins.why}</div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: C.mono, fontSize: 12.5,
        color: hover ? sev.c : C.dim, transition: "color .18s", cursor: "pointer" }}>
        investigate <ArrowRight size={14} />
      </div>
    </div>
  );
}

function Bar({ label, value, color, delta }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 7 }}>
      <span style={{ fontFamily: C.mono, fontSize: 11, color: C.faint, width: 40 }}>{label}</span>
      <div style={{ flex: 1, height: 9, borderRadius: 99, background: C.callout, overflow: "hidden" }}>
        <div style={{ width: `${Math.max(value * 100, 4)}%`, height: "100%", background: color, borderRadius: 99 }} />
      </div>
      <span style={{ fontFamily: C.mono, fontSize: 11, color: delta ? color : C.faint, width: 64, textAlign: "right" }}>
        {delta || "--"}
      </span>
    </div>
  );
}

/* ── status log (col 2) ── */
function StatusLog() {
  return (
    <div style={{ position: "sticky", top: 20 }}>
      <div style={{ borderRadius: 14, background: C.panel, border: `1px solid ${C.border}`, padding: 18 }}>
        <div style={{ fontFamily: C.mono, fontSize: 12, color: C.dim, marginBottom: 4 }}>how this briefing was gathered · {TRACE.filter(t => t.kind === "tool").length} queries</div>
        <div style={{ height: 1, background: C.border, margin: "12px 0 16px" }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 14, maxHeight: 520, overflowY: "auto" }}>
          {TRACE.map((t, i) => t.kind === "tool" ? (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "9px 12px", borderRadius: 9, background: C.callout, border: `1px solid ${C.border}` }}>
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Dot color={C.mint} size={7} />
                <span style={{ fontFamily: C.mono, fontSize: 11.5, color: C.text }}>{t.tool}</span>
              </span>
              <span style={{ fontFamily: C.mono, fontSize: 10.5, color: C.faint }}>{t.ms}ms</span>
            </div>
          ) : (
            <div key={i}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <span style={{ fontFamily: C.mono, fontSize: 10, color: C.mint, padding: "2px 8px", borderRadius: 6,
                  border: `1px solid ${C.mint}55` }}>monitoring</span>
                <span style={{ fontFamily: C.mono, fontSize: 11, color: C.faint }}>thought</span>
                <span style={{ fontFamily: C.mono, fontSize: 10, color: C.ghostText, marginLeft: "auto" }}>{t.ts}</span>
              </div>
              <div style={{ fontFamily: C.sans, fontSize: 12.5, color: C.dim, lineHeight: 1.5 }}>{t.text}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── stepper ── */
function Stepper({ found }) {
  const steps = [
    { n: 1, label: "monitoring anomalies", sub: `${found} changes found`, active: true },
    { n: 2, label: "investigating the issue", sub: "opens when you investigate" },
    { n: 3, label: "decision & recommendation", sub: "opens when you investigate" },
  ];
  return (
    <div style={{ display: "flex", borderRadius: 13, background: C.panel, border: `1px solid ${C.border}`, overflow: "hidden", marginBottom: 28 }}>
      {steps.map((s, i) => (
        <div key={s.n} style={{ flex: 1, display: "flex", alignItems: "center", gap: 12, padding: "16px 18px",
          borderRight: i < 2 ? `1px solid ${C.border}` : "none", opacity: s.active ? 1 : 0.5 }}>
          <span style={{ display: "grid", placeItems: "center", width: 26, height: 26, borderRadius: 99,
            background: s.active ? C.mint : "transparent", border: s.active ? "none" : `1px solid ${C.faint}`, flexShrink: 0 }}>
            {s.active ? <Check size={15} color={C.bg} strokeWidth={3} /> : <span style={{ fontFamily: C.mono, fontSize: 12, color: C.faint }}>{s.n}</span>}
          </span>
          <div>
            <div style={{ fontFamily: C.mono, fontSize: 13.5, color: s.active ? C.text : C.dim }}>{s.label}</div>
            <div style={{ fontFamily: C.mono, fontSize: 11, color: C.faint, marginTop: 2 }}>{s.sub}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const [highlight, setHighlight] = useState(null);
  const refs = useRef({});

  const live = CATEGORIES.filter((c) => c.coverage !== "unavailable");
  const ghost = CATEGORIES.filter((c) => c.coverage === "unavailable");
  const firing = CATEGORIES.filter((c) => c.status === "anomaly" || c.status === "spike").length;

  const pick = (id) => {
    setHighlight(id);
    refs.current[id]?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => setHighlight(null), 1600);
  };

  return (
    <div style={{ background: C.bg, minHeight: "100vh", padding: "32px 24px", fontFamily: C.sans }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Inter:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 7px; } ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 99px; }
        @keyframes ping { 75%,100% { transform: scale(2.6); opacity: 0; } }
        @keyframes rise { from { opacity:0; transform: translateY(6px);} to { opacity:1; transform:none;} }
      `}</style>

      <div style={{ maxWidth: 1024, margin: "0 auto" }}>
        {/* header */}
        <div style={{ marginBottom: 26 }}>
          <h1 style={{ fontFamily: C.mono, fontSize: 34, color: C.text, margin: 0, fontWeight: 500, letterSpacing: "-.02em" }}>blooming insights</h1>
          <div style={{ fontFamily: C.mono, fontSize: 14, color: C.dim, marginTop: 8 }}>your workspace, in bloom</div>
          <div style={{ fontFamily: C.mono, fontSize: 13, color: C.faint, marginTop: 10 }}>wobbly-ukulele · 123,162 customers</div>
          {/* demo / live toggle */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 18 }}>
            <div style={{ display: "flex", borderRadius: 9, border: `1px solid ${C.border}`, overflow: "hidden" }}>
              <span style={{ fontFamily: C.mono, fontSize: 12, padding: "7px 16px", color: C.dim }}>demo</span>
              <span style={{ fontFamily: C.mono, fontSize: 12, padding: "7px 16px", background: C.mint, color: C.bg, fontWeight: 600 }}>live</span>
            </div>
            <span style={{ fontFamily: C.mono, fontSize: 12, color: C.faint }}>live · real workspace data</span>
          </div>
        </div>

        <Stepper found={firing} />

        {/* two-column layout */}
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 18, alignItems: "start" }}>
          {/* col 1 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            {/* ── coverage grid ── */}
            <div style={{ borderRadius: 14, background: "transparent" }}>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontFamily: C.mono, fontSize: 15, color: C.text }}>anomaly coverage</div>
                  <div style={{ fontFamily: C.mono, fontSize: 11.5, color: C.dim, marginTop: 5 }}>
                    10 categories · <span style={{ color: C.mint }}>{live.length} monitored</span> · <span style={{ color: C.coral }}>{firing} firing</span> · <span style={{ color: C.ghostText }}>{ghost.length} no data</span>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 12, fontFamily: C.mono, fontSize: 10, color: C.faint }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}><Dot color={C.coral} size={6} /> anomaly</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}><Dot color={C.mint} size={6} /> clear</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}><Dot color={C.amber} size={6} /> limited</span>
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}><span style={{ width: 6, height: 6, borderRadius: 99, border: `1px dashed ${C.ghostText}` }} /> planned</span>
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
                {CATEGORIES.map((c, i) => (
                  <div key={c.id} style={{ animation: "rise .4s ease both", animationDelay: `${i * 30}ms` }}>
                    <Tile cat={c} onPick={pick} dimmed={highlight && highlight !== c.id} />
                  </div>
                ))}
              </div>
              <div style={{ marginTop: 12, padding: "11px 13px", borderRadius: 10, background: C.panel,
                border: `1px solid ${C.border}`, fontFamily: C.mono, fontSize: 10.5, color: C.dim, lineHeight: 1.55 }}>
                <span style={{ color: C.faint }}>coverage note ·</span> checked {live.length} of 10 categories against this workspace's schema. skipped <span style={{ color: C.ghostText }}>{COVERAGE_NOTE_SKIPPED.join(", ")}</span> — the required events aren't emitted here.
              </div>
            </div>

            {/* ── categorized insight cards ── */}
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {INSIGHTS.map((ins) => (
                <InsightCard key={ins.id} ins={ins} highlight={highlight === ins.id}
                  cardRef={(el) => (refs.current[ins.id] = el)} />
              ))}
            </div>
          </div>

          {/* col 2 */}
          <StatusLog />
        </div>
      </div>
    </div>
  );
}
