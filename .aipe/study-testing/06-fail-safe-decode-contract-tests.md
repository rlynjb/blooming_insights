# 06 — Fail-Safe Decode Contract Tests

**Industry name:** *fail-safe defaults* (from the security-design
principle, Saltzer & Schroeder 1975) applied to *parser contract
testing* — bad input returns null, never throws.
**Type:** Language-agnostic pattern.
**Determinism side:** DETERMINISTIC. Every case is `given specific
malformed input → assert exact null return`. The wire format is the
contract; the test is the assertion.

═════════════════════════════════════════════════
Zoom out — where this pattern sits
═════════════════════════════════════════════════

Session D shipped a settings modal that lets a portfolio visitor plug
in their own MCP server. The config rides on every streaming request
as a base64-encoded JSON HTTP header. The client encodes it; the
server decodes it. **If ANY part of that decode fails — malformed
base64, unparseable JSON, invalid shape — the request must fall
through to env defaults, not crash.** The pattern is
"fail-safe defaults": a bad header behaves exactly like no header.

```
  Zoom out — the round-trip and its 4 failure modes

  ┌─ Client (browser) ──────────────────────────────────────┐
  │  Settings modal → writePersistedConfig(config)          │
  │       │                                                  │
  │       ▼                                                  │
  │  localStorage[BI_MCP_CONFIG_KEY] = JSON.stringify(...)   │
  │       │                                                  │
  │  fetch(url, { headers: {                                  │
  │    'x-bi-mcp-config': persistedConfigHeader()             │
  │  }})                                                       │
  └───────────────────────────┬─────────────────────────────┘
                              │  base64(JSON)
  ┌─ Server (route handler) ──▼─────────────────────────────┐
  │  const override = decodeConfigHeader(req.headers.get(   │
  │    'x-bi-mcp-config'))                                   │
  │                                                          │
  │  4 failure modes to tolerate:                            │
  │  · missing header       → null                           │
  │  · empty header         → null                           │
  │  · malformed base64     → null                           │
  │  · valid base64,        → null                           │
  │    non-JSON payload                                       │
  │  · valid JSON,          → null                           │
  │    invalid shape                                          │
  │                                                          │
  │  → makeDataSource(mode, sid, override)                   │
  │       (if override is null, falls back to env vars)      │
  └─────────────────────────────────────────────────────────┘
```

Every one of the "→ null" arrows is explicitly tested. That's what
makes the pattern the pattern — not "we handle errors somewhere," but
"each named failure mode has its named test."

═════════════════════════════════════════════════
Structure pass — layers · axes · seams
═════════════════════════════════════════════════

**Layers:**
- test (feeds each malformed input to the decoder)
- decoder (`decodeConfigHeader`, `readPersistedConfig`)
- type guard (`isMcpConfigOverride`)
- normalizer (`normalizeConfig`)

**Axis held constant — failure containment:** where does failure
originate, and where does it stop?
- test (top): expects null return, no exception
- decoder: catches JSON.parse errors, atob errors, guards shape,
  returns null on any failure
- type guard: returns false on any structural mismatch
- normalizer: strips empty strings, no throw path

Failure originates at the wire format and is contained at the
decoder. Nothing above the decoder ever sees a throw.

**Seam:** the decoder function boundary. Everything below is
"external input we cannot trust"; everything above is "typed
override that either exists or doesn't." The `try/catch → return null`
IS the seam.

═════════════════════════════════════════════════
How it works
═════════════════════════════════════════════════

#### Move 1 — the mental model

You've written a form field that reads user input and calls
`parseInt` on it. `parseInt` returns `NaN` when it can't parse —
it doesn't throw. Your consumer code checks `if (isNaN(value))
default = 0`. That's the pattern: **the parser signals "I couldn't
figure this out" as a return value, not an exception,** so every
caller can treat the failure as a normal control-flow case.

Apply that to a whole round-trip: the encoder, the transport, the
decoder, the localStorage helpers — every one of them signals
"couldn't figure this out" as `null` or `false` return, never a
throw. The test suite pins each failure mode explicitly.

```
  The fail-safe decode contract

  bad input           →      null return       →   caller falls back
  malformed base64            (no throw)            to env defaults
  non-JSON payload
  invalid shape
```

Kernel — three moving parts:

- **`try/catch` at the outer decode** — catches `atob` failures
  (malformed base64) and `JSON.parse` failures (non-JSON payloads)
- **explicit type guard** — `isMcpConfigOverride(value)` returns
  false on any shape mismatch. Not "throws on mismatch;" the guard
  is a boolean function
- **explicit null return in every failure branch** — every path
  that isn't the happy path returns `null`, not `undefined`, not a
  partial object. `null` is the contract's failure signal

Drop the try/catch → malformed base64 throws to the route handler
and blows up the whole request. The user's settings-modal typo
crashes their session.

Drop the type guard → a valid base64/JSON payload with
`authType: 'malicious-mode'` gets through, and downstream
`makeAuthProvider` throws instead of falling back to defaults.

Drop the null discipline → some code paths return null, some return
`{}`, some throw. Every caller has to defend three shapes; drift
compounds.

#### Move 2 — the walkthrough

**Step 1 — the type guard (structural contract).**

The guard checks each field's type and rejects unknown enum values.
Six tests span the acceptance and rejection space:

```
  Location: test/mcp/config.test.ts:21-57

  describe('isMcpConfigOverride', () => {
    it('accepts the empty object (all fields optional)', () => {
      expect(isMcpConfigOverride({})).toBe(true);
    });

    it('accepts a fully-populated override', () => {
      expect(isMcpConfigOverride({
        url: 'https://mcp.example.com/',
        authType: 'bearer',
        bearerToken: 'tok',
      })).toBe(true);
    });

    it('accepts each valid authType', () => {
      for (const authType of ['oauth-bloomreach', 'bearer', 'anonymous'] as const) {
        expect(isMcpConfigOverride({ authType })).toBe(true);
      }
    });

    it('rejects unknown authTypes', () => {
      expect(isMcpConfigOverride({ authType: 'unknown' })).toBe(false);
      expect(isMcpConfigOverride({ authType: 42 })).toBe(false);
    });

    it('rejects wrong field types', () => {
      expect(isMcpConfigOverride({ url: 123 })).toBe(false);
      expect(isMcpConfigOverride({ bearerToken: [] })).toBe(false);
    });

    it('rejects non-object inputs', () => {
      expect(isMcpConfigOverride(null)).toBe(false);
      expect(isMcpConfigOverride('string')).toBe(false);
      expect(isMcpConfigOverride(42)).toBe(false);
    });
  });
```

Notice the exhaustive discipline in "accepts each valid authType" —
loops through the union to force any new auth type addition to break
the test until it's added. Same trick as `auth-providers.test.ts:142-153`.

**Step 2 — the round-trip (contract 1: encode↔decode).**

The full happy path — encode a config, decode it, get back the
normalized shape:

```
  Location: test/mcp/config.test.ts:85-95

  describe('encode/decodeConfigHeader round-trip', () => {
    it('encodes and decodes a full config', () => {
      const config = {
        url: 'https://mcp.example.com/',
        authType: 'bearer' as const,
        bearerToken: 'tok',
      };
      const header = encodeConfigHeader(config);
      expect(header).toBeTypeOf('string');
      expect(decodeConfigHeader(header)).toEqual(normalizeConfig(config));
    });
```

The test asserts equality with the *normalized* config, not the raw
config — because encode normalizes (strips whitespace, removes empty
strings) before base64ing. A tighter contract: whatever comes back
from decode is exactly what normalization would produce, so the
callers see a canonical shape.

**Step 3 — the failure modes (contract 2: bad input → null).**

The star of the pattern. Every named failure mode has its own test:

```
  Location: test/mcp/config.test.ts:97-121

  it('decodes to null for missing / empty inputs', () => {
    expect(decodeConfigHeader(null)).toBeNull();
    expect(decodeConfigHeader('')).toBeNull();
  });

  it('decodes to null for malformed base64', () => {
    expect(decodeConfigHeader('not-base64')).toBeNull();
  });

  it('decodes to null for base64 JSON with invalid shape', () => {
    const bad = Buffer.from(
      JSON.stringify({ authType: 'invalid-type' }),
      'utf8'
    ).toString('base64');
    expect(decodeConfigHeader(bad)).toBeNull();
  });

  it('decodes to null for non-JSON base64 payloads', () => {
    const bad = Buffer.from('this is not json', 'utf8').toString('base64');
    expect(decodeConfigHeader(bad)).toBeNull();
  });
```

Four independent failure modes → four independent tests. Each one
constructs a specific malformed input and asserts null. The
comment-in-code (`config.test.ts:107-108`) even shows the
JSON-before-base64ing so a reader can reconstruct what the test is
producing.

**Step 4 — the localStorage helpers (SSR-safe pattern).**

`readPersistedConfig` and `writePersistedConfig` face a different
failure mode: **`localStorage` may not exist** (SSR, blocked by user
setting, disabled in an incognito mode). The pattern: check the
global, gracefully no-op:

```
  Location: lib/mcp/config.ts:106-118 (production code excerpt)

  export function readPersistedConfig(): McpConfigOverride | null {
    if (typeof localStorage === 'undefined') return null;   // ← SSR guard
    try {
      const raw = localStorage.getItem(BI_MCP_CONFIG_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!isMcpConfigOverride(parsed)) return null;
      return normalizeConfig(parsed);
    } catch {
      return null;
    }
  }
```

The tests mount an in-memory shim to simulate localStorage in
Node/vitest, exercise the read path against valid/invalid data, then
tear the shim down:

```
  Location: test/mcp/config.test.ts:123-148

  describe('localStorage helpers', () => {
    let store: Record<string, string> = {};

    beforeEach(() => {
      store = {};
      (globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = v; },
        removeItem: (k) => { delete store[k]; },
        clear: () => { store = {}; },
        key: () => null,
        length: 0,
      };
    });

    afterEach(() => {
      delete (globalThis as unknown as { localStorage?: Storage })
        .localStorage;
    });

    it('readPersistedConfig returns null when unset', () => {
      expect(readPersistedConfig()).toBeNull();
    });
```

The in-memory shim is 12 lines and reusable — the same shape works
for any future client-persistence test in this repo. That's why it
earns a callout in `00-overview.md`'s "if you only read three files"
section.

**Step 5 — the write-side fail-safe (the elided contract).**

`writePersistedConfig(null)` clears the key. `writePersistedConfig({
url: '', bearerToken: '' })` ALSO clears the key — because after
normalization there's nothing to persist. Both cases are tested:

```
  Location: test/mcp/config.test.ts:174-184

  it('writing null removes the key', () => {
    store[BI_MCP_CONFIG_KEY] = JSON.stringify({
      authType: 'bearer', bearerToken: 't'
    });
    writePersistedConfig(null);
    expect(store[BI_MCP_CONFIG_KEY]).toBeUndefined();
  });

  it('writing an all-empty config removes the key', () => {
    store[BI_MCP_CONFIG_KEY] = 'anything';
    writePersistedConfig({ url: '', bearerToken: '' });
    expect(store[BI_MCP_CONFIG_KEY]).toBeUndefined();
  });
```

This IS the "reset to defaults" UX contract from the settings modal
— a user clearing all fields must reset, not persist empty strings.
The test pins it.

#### Move 2 variant — the load-bearing skeleton

Kernel: **try/catch + type guard + null return.**

- Drop try/catch → thrown errors propagate; one failure crashes the
  whole request
- Drop the type guard → shape drift passes through; the downstream
  auth-provider factory throws instead of falling back
- Drop the null discipline → callers can't tell "no override" from
  "invalid override;" the fallback logic breaks

Hardening: exhaustive enum iteration in the type guard tests, the
in-memory localStorage shim, the "write clears on all-empty"
sub-contract.

#### Move 3 — the principle

Any parser at a trust boundary should return a signal, not throw. A
malformed input is not exceptional — it's the wire-format contract's
failure case, and every consumer needs to handle it as normal
control flow. Pin the contract in tests: one test per named failure
mode. When a new failure mode appears (a new field type gets
rejected), it earns a new test, not a new comment. **This is what
"fail-safe defaults" looks like at the code level.**

═════════════════════════════════════════════════
Primary diagram
═════════════════════════════════════════════════

The full picture — every failure mode has its named test.

```
  Full picture — decoder contract as tested

  ┌─ input space (untrusted) ──────────────────────────────────┐
  │                                                             │
  │  · null                    ─┐                                │
  │  · empty string            ─┤ ─ config.test.ts:97-100        │
  │                                                              │
  │  · 'not-base64'            ── config.test.ts:102-104         │
  │                                                              │
  │  · base64(non-JSON)        ── config.test.ts:112-115         │
  │                                                              │
  │  · base64(valid JSON,      ── config.test.ts:106-110         │
  │    invalid shape)                                             │
  │                                                              │
  │  · base64(valid JSON,      ── config.test.ts:86-95           │
  │    valid shape)                                               │
  │                                                              │
  └──────────────┬──────────────────────────────────────────────┘
                 │
  ┌──────────────▼─────────────────────────────────────────────┐
  │  decodeConfigHeader (lib/mcp/config.ts:87-100)              │
  │    try {                                                    │
  │      atob(header) → JSON.parse → isMcpConfigOverride ✓      │
  │      → return normalizeConfig(parsed)   ◄── happy path      │
  │    } catch {                                                 │
  │      return null                        ◄── all failures    │
  │    }                                                         │
  └──────────────┬─────────────────────────────────────────────┘
                 │
  ┌──────────────▼─────────────────────────────────────────────┐
  │  caller: route handler                                     │
  │    const override = decodeConfigHeader(...)                 │
  │    if (override) { ... use ... }                            │
  │    else { fall through to env defaults }                    │
  └────────────────────────────────────────────────────────────┘
```

═════════════════════════════════════════════════
Elaborate
═════════════════════════════════════════════════

"Fail-safe defaults" is one of Saltzer & Schroeder's eight security
design principles ("The Protection of Information in Computer
Systems," 1975): the default action should be to deny, not to
allow. Applied to a config parser, that means: if we can't parse
your override, we don't guess — we fall back to what we know works
(the env defaults). No override is safer than a wrong override.

The pattern is common in security-adjacent code (JWT decoders,
cookie parsers, permission checks), and this repo applies it to a
non-security-adjacent surface: a config wire format. The reasoning
is the same, though — a decoder that throws forces every caller to
wrap in try/catch, which they'll do inconsistently, which becomes a
production incident. A decoder that returns null pushes the fallback
decision to the caller once, at a place they're already checking.

The `test/mcp/config.test.ts` file's structure is also worth noting:
23 tests split across 5 describes (`constants`, `isMcpConfigOverride`,
`normalizeConfig`, `encode/decode round-trip`, `localStorage
helpers`), each testing exactly one contract of the module. The
tests don't cross-mock or share fixtures — every test is self-contained.
That's what makes them easy to read and easy to add to.

The in-memory localStorage shim is the reusable artifact. Any future
test that needs to exercise client-side persistence
(useDemoCapture, useReconnectPolicy, or a future settings-migration
tool) can copy the 12-line shim. Worth extracting to
`test/helpers/localStorage-shim.ts` if a second consumer appears.

Cross-links:
- Pattern 05 (fixture-anchored) uses the same "pin the specific
  captured shape" discipline, but for the read side of a
  server-owned wire format
- `study-security` — this is a security-adjacent pattern; if the
  bearer token in the config were a token forwarded blindly, the
  encoder-decoder round-trip becomes a real trust-boundary study
- `study-system-design` — the config override IS a per-request
  override on the OAuth boundary; this pattern is how it stays
  optional

═════════════════════════════════════════════════
Interview defense
═════════════════════════════════════════════════

**Q: You added a new HTTP header carrying a client-side JSON
config. How do you keep a bad header from crashing the request?**

Answer: Decode with a fail-safe contract. `decodeConfigHeader(raw)`
either returns the validated override or `null`. Every failure mode
— missing, empty, malformed base64, non-JSON payload, invalid shape
— returns null; nothing throws. The route handler then just checks
`if (override)` and falls through to env defaults on null. Each of
the four failure modes has its own test that pins the null return.

Anchor: `lib/mcp/config.ts:87-100` (the decoder) and
`test/mcp/config.test.ts:97-121` (the 4 failure-mode tests).

Diagram sketch:

```
  bad input  ─┬─── null-return decoder ───►  caller: if (x) ... else env
             │
             │  4 named failure modes,
             │  each with its named test
             ▼
         missing / empty / malformed base64 /
         valid base64 non-JSON / valid JSON bad shape
```

**Q: Why null instead of throwing?**

Answer: Because the failure IS a normal control-flow case. A
throwing decoder forces every caller to wrap in try/catch — and
they'll do it inconsistently, they'll forget one, and a user typo
in the settings modal will crash their session. A null-returning
decoder pushes the fallback decision to the caller once, at the
place the caller was already going to check (`if (override) { ...
} else { env defaults }`). Same failure surface, cleaner control
flow.

**Q: How do you test localStorage in Node?**

Answer: Mount an in-memory shim on `globalThis.localStorage` in
`beforeEach`, tear it down in `afterEach`. Twelve lines total —
`getItem`, `setItem`, `removeItem`, `clear`, `key`, `length`. The
production code already handles the `typeof localStorage ===
'undefined'` case for SSR, so the shim just proves the code path
that DOES read localStorage behaves correctly. The shape is
copy-paste for any future client-persistence test.

Anchor: `test/mcp/config.test.ts:127-148`.

═════════════════════════════════════════════════
See also
═════════════════════════════════════════════════

- `05-fixture-anchored-schema-tests.md` — same "pin specific
  captured shape" discipline for the server-owned wire format
- `audit.md` lens 5 — the fail-safe contract as boundary-coverage
  proof
- `study-security` — the trust-boundary reasoning that motivates
  fail-safe defaults
- `study-system-design` — the config override's place in the
  OAuth-boundary architecture
