# 07 — System design templates (interview reframes)

Two AI interview templates. Not concept files — interview prompts this codebase either exemplifies or could be refactored to exemplify. Uses the fixed 9-bullet template (per spec).

## Files

- `01-search-ranking.md` — "Design a search ranking system." Applies to this codebase: **no**. This codebase doesn't do search; the ReAct loop over structured MCP tools is a different shape. How-to-make-it-apply named.
- `02-tech-support-chatbot.md` — "Design a tech support chatbot." Applies to this codebase: **partially**. The ReAct agent + structured output pattern maps directly to a chatbot's request-response with escalation. The workspace-analyst framing isn't a chatbot but the mechanisms are structurally similar.

## Curriculum

Phase 5 — concepts C5.10 (Search ranking), C5.14 (Tech support chatbot).
