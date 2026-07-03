# settings modal with localStorage persistence

## Subtitle

**client-side config override via localStorage → request header** · industry standard for "bring your own backend" settings panels · variant of *localStorage-backed preferences* + *per-request config injection via HTTP header*.

## Zoom out, then zoom in

**Zoom out — the bigger picture.** New in Session D. A portfolio visitor can plug in their own MCP server without touching env or forking the repo. The modal writes a config override to `localStorage['bi:mcp_config']`; the streaming hooks read it on every `fetch()` and attach it as an HTTP header; the route handler decodes the header and hands the override to `makeDataSource`. Header unset → env-driven behavior preserved. Zero server state, zero React context, one `window.location.reload()` to make the new config take effect.

```
  Zoom out — where the settings modal sits

  ┌─ UI layer ─────────────────────────────────────────────────────┐
  │  page.tsx settings button → ★ McpConfigModal ★  ← we are here    │
  │  (visible only when mode === 'live-mcp')                          │
  └──────────────────────────┬─────────────────────────────────────┘
                             │  writePersistedConfig(overrideObj)
                             ▼
  ┌─ Web Storage ──────────────────────────────────────────────────┐
  │  localStorage['bi:mcp_config'] = JSON.stringify(overrideObj)     │
  └──────────────────────────┬─────────────────────────────────────┘
                             │  read on next fetch
                             ▼
  ┌─ Streaming hooks (client) ─────────────────────────────────────┐
  │  useBriefingStream / useInvestigation                            │
  │  persistedConfigHeader() → base64(JSON) → header value           │
  │  fetch('/api/…', { headers: { 'x-bi-mcp-config': v } })          │
  └──────────────────────────┬─────────────────────────────────────┘
                             │  HTTP request
                             ▼
  ┌─ Server route ─────────────────────────────────────────────────┐
  │  decodeConfigHeader(req.headers['x-bi-mcp-config'])              │
  │  → validated McpConfigOverride | null                            │
  │  → makeDataSource(overrideOrEnv) → connectMcp                    │
  └────────────────────────────────────────────────────────────────┘
```

**Zoom in — narrow to the concept.** The pattern is *localStorage-backed override + per-request header injection*. The modal is not the state — localStorage is. The modal is a form that reads/writes localStorage; the hooks that make requests read localStorage independently. If you unmount the modal, close the tab, come back — the override is still in force because the hooks read it again on next mount. If you clear localStorage, the header goes away and env takes over. Simplest possible state model for "let the user override server config."

## Structure pass

Skeleton before mechanics.

**Layers — from modal to server route.**

```
  Layers — where each piece of the override lives

  ┌─ layer 1: form state (in-modal, useState)          ─┐
  │   url, authType, bearerToken, initialized            │
  ├─ layer 2: persisted state (localStorage)           ─┤
  │   localStorage['bi:mcp_config'] = normalized JSON    │
  ├─ layer 3: transport (HTTP header)                  ─┤
  │   header value = base64(JSON.stringify(config))      │
  ├─ layer 4: server-side use (route handler)          ─┤
  │   decode → validate → override env → connectMcp      │
  └──────────────────────────────────────────────────────┘
```

**Axis held constant — where does the config live at each layer?**

  - Layer 1: form state → lives in the modal's `useState`, dies on unmount.
  - Layer 2: persisted → lives in localStorage, survives reload, cleared by "reset."
  - Layer 3: transport → lives in the request header, one-shot per fetch.
  - Layer 4: server → lives in a request-scoped local variable, dies with the response.

**Same config, four lifetimes.** Deliberately no shared reference — each layer has its own copy at its own scope. That's the discipline that keeps this pattern from developing stale-state bugs.

**Seams — where the config's lifetime flips.**

  - Layer 1 → 2: `Save` click. Modal writes localStorage; unmounts on close.
  - Layer 2 → 3: every `fetch()`. Hook reads localStorage; if present, adds a header; else omits.
  - Layer 3 → 4: HTTP boundary. Server decodes the header; validates; passes to `makeDataSource`.

Three seams, three contract changes. Each side deliberately doesn't hold a reference to the other — the config gets re-read at every seam.

## How it works

### Move 1 — the mental model

You know how a `<form>` with controlled inputs works? Each field has a state variable; typing updates the state; a `Save` handler writes something somewhere. This pattern is that, with three twists:

  1. The "somewhere" is `localStorage`, not a server.
  2. The state doesn't drive the app directly — the hooks that make requests read localStorage themselves.
  3. Save calls `window.location.reload()` to make the new state take effect.

The reload sounds heavy but it's the right call: it makes the state model trivial. No prop-drilling of the override into every fetch; no React context provider; no signals; no invalidation graph. The hooks read localStorage on effect-mount; the reload guarantees a fresh mount with the new value.

```
  Pattern — form ↔ localStorage ↔ hook, three actors, one shared string

    ┌───────────┐                    ┌──────────────┐
    │  modal    │ writePersisted → ──│ localStorage │
    │  useState │                    │ 'bi:mcp_cfg' │
    │  form     │ ← readPersisted ──│              │
    └───────────┘                    └──────────────┘
          │                                  │
          │ Save → onSaved()                  │
          ▼                                   │  hook re-reads
    window.location.reload()                  │  on effect-mount
          │                                   │
          └───────────────────┬───────────────┘
                              ▼
                      ┌──────────────┐
                      │  fetch hook  │
                      │  reads LS,   │
                      │  adds header │
                      │  if present  │
                      └──────────────┘
```

Three actors, one shared string. No shared state object; no synchronization primitives.

### Move 2 — the step-by-step walkthrough

Walk each of the four moving parts, one at a time.

#### Part 1 — the modal opens: hydrate form from localStorage

The modal takes `{ open, onClose, onSaved? }` — the open state is owned by the parent (`app/page.tsx:49`). When it opens, it hydrates its own form state from the persisted config so the fields show what's currently saved.

```typescript
// components/settings/McpConfigModal.tsx:34-48
export function McpConfigModal({ open, onClose, onSaved }: Props) {
  const [url, setUrl]                 = useState('');
  const [authType, setAuthType]       = useState<McpAuthType>('oauth-bloomreach');
  const [bearerToken, setBearerToken] = useState('');
  const [initialized, setInitialized] = useState(false);

  // Load persisted config on open.
  useEffect(() => {
    if (!open) return;
    const c = readPersistedConfig();          // ← reads from localStorage
    setUrl(c?.url ?? '');
    setAuthType(c?.authType ?? 'oauth-bloomreach');
    setBearerToken(c?.bearerToken ?? '');
    setInitialized(true);
  }, [open]);

  if (!open) return null;                     // ← early return; no render when closed
```

The `if (!open) return null` at `:50` means the component doesn't render its DOM at all when closed. This isn't purely cosmetic — the `<div role="dialog" aria-modal="true">` gets no announcement, and no focus trap fires, when it's not rendered. Cleaner than `display: none` on an always-mounted container.

**What breaks if this hydration is missing:** the user opens the modal, sees defaults, saves, and silently blows away whatever they'd previously configured.

#### Part 2 — the form fields (controlled inputs with conditional token)

Three fields, plain HTML inputs, each with an `onChange` that setStates its slot. The bearer token field only renders when `authType === 'bearer'`:

```typescript
// components/settings/McpConfigModal.tsx:170-205 (trimmed)
{authType === 'bearer' && (
  <label>
    <div>bearer token</div>
    <input
      type="password"
      placeholder="paste token"
      value={bearerToken}
      onChange={(e) => setBearerToken(e.target.value)}
    />
    <div style={{ color: 'var(--accent-amber)' }}>
      ⚠ tokens in localStorage are less protected than the encrypted
      bi_auth cookie. use test tokens; do not paste production credentials.
    </div>
  </label>
)}
```

The security warning is in-UI, not in a doc — the user sees it exactly when the risk becomes relevant. This is the *trust boundary* being surfaced at the point of decision, not buried in a README.

The Save button is disabled when the auth type demands a token but the token is empty:

```typescript
// components/settings/McpConfigModal.tsx:274-293 (trimmed)
<button
  type="button"
  onClick={save}
  disabled={authType === 'bearer' && !bearerToken.trim()}
  style={{
    background: 'var(--accent-teal)',
    color: 'var(--bg-base)',
    cursor:
      authType === 'bearer' && !bearerToken.trim() ? 'not-allowed' : 'pointer',
    opacity: authType === 'bearer' && !bearerToken.trim() ? 0.5 : 1,
    // ...
  }}
>
  save
</button>
```

Validation at the UI level, one guard, three places in the button (disabled, cursor, opacity). Server-side validation (in `isMcpConfigOverride` at `lib/mcp/config.ts:50-60`) is the real safety net — the UI validation is UX polish.

```
  State diagram — the Save button

    ┌─────────────┐  authType=bearer &&        ┌──────────────┐
    │ enabled     │  bearerToken.trim() === '' │ disabled     │
    │ (teal, →)   │ ──────────────────────────►│ (0.5 opacity,│
    │             │◄────── token typed ────────│  not-allowed)│
    └─────────────┘                            └──────────────┘
       │                                              │
       │ Save clicked                                 │
       ▼                                              (click swallowed)
    writePersistedConfig(...)
    onSaved()
    onClose()
```

#### Part 3 — Save writes localStorage → reload

The Save handler is 12 lines. Build the override object, validate token presence, write, notify, close:

```typescript
// components/settings/McpConfigModal.tsx:52-63
const save = () => {
  const config: McpConfigOverride = {
    url: url.trim() || undefined,
    authType,
    bearerToken:
      authType === 'bearer' ? bearerToken.trim() || undefined : undefined,
  };
  // Bearer-selected but no token → don't save; the UI shows the warning.
  if (authType === 'bearer' && !config.bearerToken) return;
  writePersistedConfig(config);
  onSaved?.();
  onClose();
};
```

`writePersistedConfig` is at `lib/mcp/config.ts:121-138`:

```typescript
export function writePersistedConfig(config: McpConfigOverride | null): void {
  if (typeof localStorage === 'undefined') return;      // ← SSR-safe
  try {
    if (config === null) {
      localStorage.removeItem(BI_MCP_CONFIG_KEY);        // ← reset case
      return;
    }
    const normalized = normalizeConfig(config);
    if (!normalized.url && !normalized.authType && !normalized.bearerToken) {
      localStorage.removeItem(BI_MCP_CONFIG_KEY);        // ← empty-override case
      return;
    }
    localStorage.setItem(BI_MCP_CONFIG_KEY, JSON.stringify(normalized));
  } catch {
    /* localStorage unavailable — silent no-op */
  }
}
```

Two "reset to defaults" paths handled in one function: explicit `null` (Reset button) and effectively-empty config. Both call `removeItem`, which means the next fetch reads `null` and omits the header, which means env takes over.

The parent's `onSaved` callback triggers the reload:

```typescript
// app/page.tsx:258-266
<McpConfigModal
  open={settingsOpen}
  onClose={() => setSettingsOpen(false)}
  onSaved={() => {
    // Fresh config → reload so the streaming fetch picks up the new
    // header on a clean state.
    if (typeof window !== 'undefined') window.location.reload();
  }}
/>
```

**Why reload instead of "invalidate the query and re-fetch"?** No query library; no invalidation graph. The streaming hooks read localStorage exactly once per effect-mount (`persistedConfigHeader()` in the fetch call). To make them re-read, you either (a) trigger a fresh effect run (which needs a dependency change), or (b) reload the page. Option (b) is one line, deterministic, and avoids any "did I remember to add the new dep" bug. The cost is a full-page refresh — acceptable for a settings save.

```
  Layers-and-hops — Save click to updated fetch

  ┌─ modal ────────────────────────────────┐  hop 1: writePersistedConfig(cfg)
  │  save() called                          │ ─────────────────────────────────►
  └────────────────────────────────────────┘
                                              hop 2: localStorage.setItem(key, JSON)
                                              ─────────────────────────────────►
  ┌─ browser storage ──────────────────────┐
  │  localStorage['bi:mcp_config'] = "…"    │  hop 3: onSaved() → reload()
  └────────────────────────────────────────┘ ─────────────────────────────────►

  ┌─ new page load (fresh JS state) ───────┐  hop 4: hook mounts, calls
  │  useBriefingStream initial effect       │           persistedConfigHeader()
  └────────────────────────────────────────┘ ─────────────────────────────────►

  ┌─ persistedConfigHeader() ──────────────┐  hop 5: readPersistedConfig() →
  │  reads LS, returns base64(JSON) or null │           encodeConfigHeader → value
  └────────────────────────────────────────┘ ─────────────────────────────────►

  ┌─ fetch call ───────────────────────────┐
  │  fetch('/api/briefing', {                │
  │    headers: { 'x-bi-mcp-config': val } }) │ ──────► server picks up override
  └────────────────────────────────────────┘
```

#### Part 4 — the hooks read localStorage per fetch

Both streaming hooks — `useBriefingStream` and `useInvestigation` — do the same thing at fetch time:

```typescript
// lib/hooks/useBriefingStream.ts:164-169  (mirrored at useInvestigation.ts:187-191)
// UI settings modal (Session D) persists MCP config in localStorage;
// send it as a header so the route can override env-driven defaults.
// Unset → header omitted → env-driven behavior preserved.
const mcpHeader = persistedConfigHeader();
const res = await fetch(url, {
  headers: mcpHeader ? { [BI_MCP_CONFIG_HEADER]: mcpHeader } : undefined,
});
```

`persistedConfigHeader()` at `lib/mcp/config.ts:142-146`:

```typescript
export function persistedConfigHeader(): string | null {
  const config = readPersistedConfig();
  if (!config) return null;                    // ← unset → omit header
  return encodeConfigHeader(config);           // ← set → base64-encoded JSON
}
```

The `? {...} : undefined` on the fetch options is deliberate — passing `headers: {}` sends an empty headers object (which is fine but wasteful); passing `undefined` means the fetch call uses only its defaults. And critically, when the header is omitted, the server-side branch is `decodeConfigHeader(null) → null → fall through to env` (`lib/mcp/config.ts:87-88`). Unset in the UI = env behavior preserved.

```
  Two paths — override present vs absent

    localStorage has 'bi:mcp_config':
      persistedConfigHeader() → "eyJ1cmwiOiJodHRwczovL…" (base64 JSON)
      fetch(url, { headers: { 'x-bi-mcp-config': "eyJ…" } })
      → server decodes → override wins over env

    localStorage empty:
      persistedConfigHeader() → null
      fetch(url, { headers: undefined })
      → header absent → server uses env
```

That's the whole pattern. Modal writes; hook reads on next fetch; reload guarantees "next fetch" happens immediately after save.

### Move 3 — the principle

**Persist config where it lives longest and re-read at every seam.** The modal's `useState` is short-lived form state — it's the temporary editing surface. localStorage is the long-lived home. The hooks that make requests aren't listening to any React state; they read localStorage themselves at fetch time. The result is a state model with zero synchronization — nobody's holding a stale copy because nobody's holding any copy.

The reload isn't a workaround for a stale-state bug — it's the design. It says: "the config changed; start fresh with everything reading the new value." One line replaces an entire class of invalidation bugs.

Generalization: whenever a config change needs to propagate to multiple independent readers, the smallest bug-free implementation is (1) one persistent source of truth, (2) each reader re-reads at its own boundary, (3) whatever mechanism makes the readers re-read (reload, effect re-run, event). Skip the shared reference; skip the observer pattern; skip the invalidation graph.

## Primary diagram

```
  Settings modal — full picture, four layers, three seams

  ┌─ page.tsx ───────────────────────────────────────────────────────┐
  │  const [settingsOpen, setSettingsOpen] = useState(false)          │
  │  {mode === 'live-mcp' && <button>⚙ settings</button>}              │
  │  <McpConfigModal open={settingsOpen}                              │
  │                  onClose={() => setSettingsOpen(false)}           │
  │                  onSaved={() => window.location.reload()} />      │
  └────────────────────┬─────────────────────────────────────────────┘
                        │
                        ▼  open flips true
  ┌─ McpConfigModal (react-only, no context, no store) ──────────────┐
  │  useEffect(open) → readPersistedConfig() → setUrl/authType/token │
  │  <form> url + authType select + conditional bearer               │
  │  save() → build override → writePersistedConfig → onSaved →      │
  │           onClose                                                 │
  │  reset() → writePersistedConfig(null) → onSaved → onClose        │
  └────────────────────┬─────────────────────────────────────────────┘
                        │
                        ▼  writePersistedConfig(config)
  ┌─ localStorage['bi:mcp_config'] ──────────────────────────────────┐
  │  JSON.stringify(normalized override)  OR  removed                 │
  └────────────────────┬─────────────────────────────────────────────┘
                        │
                        ▼  onSaved → window.location.reload()
                     [ full page reload ]
                        │
                        ▼  fresh mount
  ┌─ useBriefingStream / useInvestigation ──────────────────────────┐
  │  persistedConfigHeader()                                          │
  │    → readPersistedConfig() from LS                                │
  │    → encodeConfigHeader (btoa(JSON.stringify(...)))               │
  │    → return string OR null                                        │
  │  fetch(url, { headers: mcpHeader ? { 'x-bi-mcp-config': v } :     │
  │                                     undefined })                  │
  └────────────────────┬─────────────────────────────────────────────┘
                        │  HTTP GET with (or without) header
                        ▼
  ┌─ server route handler ──────────────────────────────────────────┐
  │  const raw = req.headers.get('x-bi-mcp-config')                   │
  │  const override = decodeConfigHeader(raw)  // atob + JSON.parse + │
  │                                             // isMcpConfigOverride │
  │  const ds = makeDataSource(override ?? envDefaults)               │
  │  … stream via readNdjson-consumer …                               │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

**Where this pattern comes from.** localStorage-backed preferences date to 2010 (HTML5 Web Storage). The pattern of *"user config in the browser → sent as a header on every request → server merges with defaults"* is the standard shape for "bring your own backend" tools: think API playgrounds (Postman, Insomnia), MCP inspectors, GraphQL clients like GraphiQL, VS Code's REST Client. All ship it because the alternatives (server-side session, cookies, env vars) are worse for the "let a portfolio visitor plug in their own endpoint" case.

**Why base64-encode the header?** HTTP headers are ASCII-only by protocol. A URL with unicode characters, a bearer token with symbols — those could break a raw header value. `btoa(JSON.stringify(config))` guarantees ASCII output and preserves round-trip integrity. See `lib/mcp/config.ts:77-82` and the mirroring `decodeConfigHeader` at `:87-100`.

**Why not encrypt the token, put it in a cookie?** Named in the code comments at `lib/mcp/config.ts:19-22`:
> *Future work: encrypt bearer token into a short-lived cookie server-side so it doesn't ride the header plaintext on every subsequent request*

The current shape is "portfolio visitor's test token in localStorage." Encrypted cookie would need a server-side session, a rotation strategy, and a bigger trust model. Deferred, deliberately.

**The trust story surfaced in the UI itself.** The security warning at `components/settings/McpConfigModal.tsx:200-203` names the tradeoff at the point of decision:
> *tokens in localStorage are less protected than the encrypted bi_auth cookie. use test tokens; do not paste production credentials.*

And the trust-boundary block at `:208-236` says out loud that the MCP server sees every tool call. This is the *inform the user of the trust boundary at the point of consent* discipline, done as UI copy. Cross-link to `study-security` for the full boundary walk.

**What could earn its place next.** Live-preview of the config (test connection button that fires a single ping to the URL before Save). Session-key derivation (browser generates a short-lived AES key, encrypts the token, only the derived key stays in localStorage). Neither is worth the complexity today.

## Interview defense

### Q1 — Why localStorage + reload instead of React state / context?

Two readers of the config live outside React's render loop: the streaming hooks that make `fetch()` calls. They already read localStorage on effect-mount for `bi:mode`. Adding one more read (`bi:mcp_config`) at the same seam is the least ceremony. If I put the config in React state or context, I'd need to plumb it through the hook signature, add it to the effect deps, and worry about stale closures. The reload trades a full page load for a zero-plumbing state model.

```
  Comparison — three ways to make the new config take effect

    A) React state + prop drilling
       parent<config> → useBriefingStream(config, ...)
       Save → setParentConfig → hook effect re-runs (config in deps)
       Cost: threading config through every fetching hook signature.

    B) React context
       <ConfigProvider><App/></ConfigProvider>
       hook reads useContext(ConfigContext)
       Save → provider setState → context consumers re-render → fetch re-runs
       Cost: extra provider, all consumers re-render on config change.

    C) localStorage + reload  ← chosen
       Save → writePersistedConfig → reload
       Fresh mount: hook reads LS on effect start, adds header if present
       Cost: one page refresh per save.
```

**Anchor.** `app/page.tsx:258-266` (reload trigger). `lib/hooks/useBriefingStream.ts:164-169` (per-fetch read).

### Q2 — The load-bearing part everyone forgets on this pattern

**The `? {…} : undefined` on the fetch headers.** If you pass `{ 'x-bi-mcp-config': null }` or `{ 'x-bi-mcp-config': '' }` or even always-present-empty headers, some server code paths get confused: is empty-string valid or invalid? The clean contract is "header present with a value = override applies" vs "header absent = fall through to env." The ternary that omits the header entirely when there's no config is what makes the two branches unambiguous.

```
  Ternary discipline — header present or absent, never present-and-empty

    const mcpHeader = persistedConfigHeader();

    ✓ CORRECT:
      fetch(url, { headers: mcpHeader ? { [KEY]: mcpHeader } : undefined })
      → server sees header OR sees nothing

    ✗ WRONG:
      fetch(url, { headers: { [KEY]: mcpHeader ?? '' } })
      → server always sees header; empty string is ambiguous
      → server code path: is '' valid? invalid? fall through?
```

**Anchor.** `lib/hooks/useBriefingStream.ts:167-169`; `lib/hooks/useInvestigation.ts:189-191`. Same shape both places.

### Q3 — How does the auth type dropdown gate the bearer input?

The dropdown is a controlled `<select>` whose value is `authType`. The bearer input renders only when `authType === 'bearer'` (`components/settings/McpConfigModal.tsx:171`). When the user switches from `bearer` to `oauth-bloomreach`, the bearer input unmounts; its `useState` value stays in memory (the modal component is still mounted) but isn't rendered. If they switch back, they see their token again. On Save, the bearer only ends up in the persisted config when `authType === 'bearer'` (`:56`).

```
  State machine — authType drives which fields are visible

    ┌──────────────────┐
    │ oauth-bloomreach │◄── default; bearer input hidden
    └──────────────────┘
             │  switch
             ▼
    ┌──────────────────┐
    │  bearer          │◄── bearer input renders; Save disabled if empty
    └──────────────────┘
             │  switch
             ▼
    ┌──────────────────┐
    │  anonymous       │◄── no token, "sends no Authorization"
    └──────────────────┘
             │
             ▼  Save
    persisted = { url, authType, bearerToken: authType === 'bearer' ? … : undefined }
```

**Anchor.** `components/settings/McpConfigModal.tsx:145-168` (dropdown), `:171-205` (conditional field), `:52-63` (Save serialization).

### Q4 — Name the security tradeoff in the UI, in one sentence

Bearer tokens in localStorage are accessible by any script running on the origin, including any XSS — the encrypted `bi_auth` cookie (AES-256-GCM, HttpOnly) is not. The modal surfaces this at `:200-203`: "tokens in localStorage are less protected than the encrypted bi_auth cookie. use test tokens; do not paste production credentials." Named in the audit as R2. The mitigation the modal doesn't have yet: server-side encryption into a short-lived cookie (deferred; see the comment at `lib/mcp/config.ts:19-22`).

**Anchor.** `components/settings/McpConfigModal.tsx:192-203` (in-UI warning); `lib/mcp/config.ts:19-22` (deferred fix note). Cross-link: `study-security` for the full trust-boundary story.

## See also

  - `01-ndjson-stream-reader-hook.md` — the streaming hooks that read the header.
  - `02-progressive-skeleton-with-stepper.md` — the UI those streams drive.
  - `audit.md` → `state-architecture` — the state-graph placement of `bi:mcp_config`.
  - `audit.md` → `frontend-red-flags-audit` R2 — the localStorage-vs-cookie trust gap.
  - Cross-guide: full trust-boundary discussion (bearer plaintext, XSS surface, cookie-encryption plan) → `study-security`.
  - Cross-guide: header semantics, ASCII-safety, per-request-config transport → `study-networking`.
