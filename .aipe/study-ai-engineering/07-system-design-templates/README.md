# 07 — system design templates

Interview reframes. Same code, different framing — "if an interviewer
says 'design X system,' can you walk through *this* codebase as that
system?" Two AI templates: search ranking, tech support chatbot. Each
follows the fixed 9-bullet shape — not the per-concept-file template.

## Files

```
01-search-ranking.md         ← search ranking system design
02-tech-support-chatbot.md   ← tech support chatbot system design
```

## How to use these

When an interviewer asks "design a search ranking system" or "design a
tech support chatbot," the templates give you a whiteboard structure
to follow:

  prompt → standard architecture → data model → key components → scale
  concerns → eval framing → common failure modes → applies to this
  codebase → how to make it apply.

Walk the standard architecture first (60 seconds, draw the boxes), then
dive deep on whichever lens the interviewer probes. The "applies to
this codebase" answer is honest about what's already built and what
isn't; the "how to make it apply" names the concrete refactor that
would land it.
