# Front matter — the through-line and the running example

Before any chapter: the one claim the entire book is in service of, and the small piece of code we'll use to make every principle land.

---

## The through-line

Every chapter of *A Philosophy of Software Design* is in service of a single argument. State it once, thread it through everything.

```
  THE THROUGH-LINE — complexity is the enemy

  ┌─ what complexity feels like (the 3 symptoms) ────────────────────────┐
  │                                                                       │
  │   change amplification  ─→ one logical change touches many places     │
  │   cognitive load        ─→ how much you must hold in your head        │
  │   unknown unknowns      ─→ you can't tell what a change will break    │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │  caused by
                                  │
  ┌─ what produces it (the 2 causes) ────────────────────────────────────┐
  │                                                                       │
  │   dependencies   ─→ code that can't be understood standalone          │
  │   obscurity      ─→ important information that isn't obvious          │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘
                                  ▲
                                  │  fought with
                                  │
  ┌─ the weapon ─────────────────────────────────────────────────────────┐
  │                                                                       │
  │   DEEP MODULES — small interface, large body                          │
  │     + hide decisions inside one place                                 │
  │     + pull complexity down so callers don't carry it                  │
  │                                                                       │
  └───────────────────────────────────────────────────────────────────────┘
```

Three symptoms. Two causes. One weapon. That triad is the whole book.

Every chapter introduces a technique. Every chapter has to close the loop back to this picture: *which symptom does this technique reduce, by removing which cause?* If you can't answer that question, the technique didn't earn the page.

That's why every chapter in this guide has a beat titled **"Why it cuts complexity"** — it names which symptom and which cause the principle is aimed at. Skip that beat and the chapter is decoration.

---

## What complexity *isn't*

Two clarifications, before we go.

**Complexity is not "how hard the problem is."** A real-time fraud detector is genuinely complex because the *problem* is complex. That's not what we're talking about. We're talking about the *accidental* complexity the code adds on top of the problem — the part you can choose not to ship.

**Complexity is not measured at one moment.** It's a tax that compounds. The line of code you add today that nobody reads tomorrow costs nothing tomorrow. The line you add that someone has to re-read every time they edit nearby code costs forever. The book is about the second kind.

---

## The running example — `parseAgentJson`

One small piece of `blooming_insights` carries the book. We'll revisit it across chapters and watch it stack up principle after principle.

**Where it lives:** `lib/mcp/validate.ts:3-13`.

**What it does:** the four agents (monitoring, diagnostic, recommendation, query) all end their loops by printing out their final answer as JSON. But Claude doesn't always return clean JSON. Sometimes it wraps the JSON in a ` ```json ` code fence. Sometimes it adds prose before or after. Sometimes the fence closes early and there's a stray comma. Somebody has to take *whatever the model emitted* and either pull a real object out of it, or admit it can't be parsed. That somebody is `parseAgentJson`.

**Its current shape — eleven lines of body, one-line interface:**

```
  parseAgentJson(text: string) → unknown        // the interface

  inside:
    1. look for a ```json fence; if found, take its contents
    2. trim, try JSON.parse — return on success
    3. otherwise scan for the outermost [ or { and matching ] or }
    4. JSON.parse that slice — return on success
    5. nothing parseable → throw

    (callers wrap that throw in try/catch and degrade to [])
```

**Why this is the carrier:** it's small enough to fit on one screen, deep enough to demo every primitive Ousterhout teaches, and it actually exists in this repo. Most "deep module" examples in design books are toys; this one is shipping.

Here's how it earns its chapters:

- **Chapter 3 (deep modules).** One function signature; eleven lines of body absorbing five LLM quirks. Functionality-to-interface ratio is huge.
- **Chapter 4 (information hiding).** Callers don't know fences exist. The "fenced-vs-bare" decision lives entirely inside the function.
- **Chapter 5 (general-purpose).** The return type is `unknown`, not `Anomaly[]`. One function works for monitoring, diagnostic, recommendation, query.
- **Chapter 7 (pull complexity down).** Five quirks live in one place. Four callers stay one-line each.
- **Chapter 9 (define errors out of existence).** The callers don't `try/catch` — they wrap once, catch once, fall back to `[]`. The error story is centralized.
- **Chapter 15 (consistency).** The same null-on-failure shape appears in `McpClient`, the Bloomreach error envelopes, the demo replay path. One reader convention covers many sites.
- **Chapter 18 (performance).** Called once per agent turn. The LLM call dominates by four orders of magnitude. Its perf is irrelevant.

You'll see it again, evolved or re-read, in each of those chapters. Other chapters (1, 2, 6, 8, 10, 11, 12, 13, 14, 16, 17, 19) build on other parts of the codebase, because forcing one example everywhere is itself a violation of the book.

---

## The v0 — what it would look like naive

If a junior engineer were to write the first version, it'd look like this:

```
  parseAgentJson(text: string): unknown {
    return JSON.parse(text);   // hope the model returned clean JSON
  }
```

Five characters of body. One line of interface.

And it would break the *first* time Claude wrapped its output in a ` ```json ` fence, which it does *constantly*. The naive version would throw at every monitoring scan, and the briefing route would degrade to "no anomalies" every time.

The real function in this repo isn't smarter because someone over-engineered it. It's smarter because shipping taught it five things, each of which it now absorbs without leaking up. That's the arc of the next 19 chapters.

---

## Carry forward

Chapter 1 names what we're fighting. Then chapter 2 makes the case that fighting it at all is the only sustainable strategy, and chapter 3 hands you the weapon.
