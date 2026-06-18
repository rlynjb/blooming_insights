# AptKit Migration Status

Last updated: 2026-06-18

## Summary

Blooming's active agent path now runs through `@aptkit/core`. The local Blooming code keeps compatibility wrappers so the app routes, tests, and eval scripts can continue using the existing constructor and method names while AptKit owns the reusable agent behavior.

The migration is intentionally non-destructive. Legacy Blooming implementations remain in `*-legacy.ts` files and legacy prompt/validator/runtime helpers are isolated under `lib/agents/`.

## Current AptKit-Backed Surfaces

| Blooming surface | Active file | AptKit source | Legacy retained |
| --- | --- | --- | --- |
| Recommendation agent | `lib/agents/recommendation.ts` | `RecommendationAgent` from `@aptkit/core` | `lib/agents/recommendation-legacy.ts` |
| Monitoring agent | `lib/agents/monitoring.ts` | `AnomalyMonitoringAgent` from `@aptkit/core` | `lib/agents/monitoring-legacy.ts` |
| Diagnostic agent | `lib/agents/diagnostic.ts` | `DiagnosticInvestigationAgent` from `@aptkit/core` | `lib/agents/diagnostic-legacy.ts` |
| Query agent | `lib/agents/query.ts` | `QueryAgent` from `@aptkit/core` | `lib/agents/query-legacy.ts` |
| Intent classification | `lib/agents/intent.ts` | `parseIntent` / `classifyIntent` from `@aptkit/core` | `lib/agents/intent-legacy.ts` |
| Category coverage | `lib/agents/categories.ts` | ecommerce category registry and coverage helpers from `@aptkit/core` | `lib/agents/categories-legacy.ts` |
| Agent runtime loop | `lib/agents/base.ts` only exports model/type glue | AptKit runtime via core agents | `lib/agents/base-legacy.ts` |
| Legacy prompts | active agents use AptKit prompt packages | `@aptkit/prompts` via core agents | `lib/agents/legacy-prompts/` |
| Legacy output validators | active agents use AptKit validators | AptKit validators via core agents | `lib/agents/legacy-validate.ts` |

## Commit Checkpoint

Blooming commits:

- `4e70eb7` Use AptKit core recommendation agent
- `1b65ecd` Refresh AptKit core bundle
- `4d26e73` Migrate monitoring agent to AptKit core
- `eb98d53` Migrate diagnostic agent to AptKit core
- `d832e6d` Migrate query agent to AptKit core
- `bd784e2` Migrate intent classification to AptKit core
- `4f98eb9` Isolate legacy agent runtime
- `c006b24` Isolate legacy agent prompts
- `73ab50f` Isolate legacy agent validators
- `8fb5091` Migrate category coverage to AptKit core

AptKit commits:

- `6e2aaff` Add core umbrella package
- `61a6969` Fix recommendation package tarballs
- `ceb4e51` Add Blooming AptKit core migration plan
- `753da01` Expand core agent exports

## Active Adapters

`lib/agents/aptkit-adapters.ts` is the main compatibility bridge:

- `AnthropicModelProviderAdapter` adapts Blooming's Anthropic SDK instance to AptKit's `ModelProvider`.
- `BloomingToolRegistryAdapter` adapts Blooming data sources to AptKit's `ToolRegistry`.
- `BloomingTraceSinkAdapter` maps AptKit trace events back into Blooming `ToolCall` and streaming hooks.

This file is still app-specific and should remain in Blooming unless AptKit later provides a reusable Anthropic SDK adapter package.

## Remaining Active Blooming Code

### Keep As Blooming-Specific

- `app/api/agent/route.ts` and `app/api/briefing/route.ts`: route orchestration, session handling, demo mode, NDJSON event emission, and UI-facing event shapes.
- `lib/mcp/*`: Blooming's MCP client/session/schema/data-source layer. This is app integration code, not generic AptKit agent behavior.
- `lib/state/*`, `lib/hooks/*`, `components/*`: product UI/state code.
- `lib/agents/aptkit-adapters.ts`: adapter glue between Blooming runtime objects and AptKit core contracts.

### Candidate For AptKit Migration

- `lib/mcp/tools.ts`: tool allowlists overlap conceptually with AptKit's tool policies. AptKit currently enforces policies inside each agent, but Blooming still uses local lists for API allowlists and tool coverage checks.
- `lib/agents/tool-schemas.ts`: still useful for legacy code and MCP allowlists. Active AptKit agents receive full tool definitions and apply AptKit policies internally.
- `eval/scripts/*`: Blooming-specific eval harnesses still call the app's wrappers. These could remain as product regression tests or migrate gradually to AptKit replay/eval artifacts.
- `lib/agents/monitoring.ts` `schemaSummary`: still exported for tests and legacy agents import `schemaSummary` from the active monitoring wrapper. AptKit has its own schema summary, but Blooming's copy remains for compatibility.

### Legacy-Only

- `lib/agents/*-legacy.ts`
- `lib/agents/base-legacy.ts`
- `lib/agents/legacy-prompts/*`
- `lib/agents/legacy-validate.ts`
- `test/agents/base.test.ts`
- `test/agents/synthesis-instruction.test.ts`
- `test/mcp/validate.test.ts`

These exist to preserve old behavior and tests while the active app uses AptKit.

## Known Notes

- `package.json` currently points `@aptkit/core` at a local tarball path: `file:../../../../private/tmp/aptkit-packs/aptkit-core-0.0.0.tgz`. This is fine for local migration testing but should be replaced by a stable GitHub URL, workspace path, or registry package before sharing the repo broadly.
- Full `npm run lint` still has unrelated existing lint debt outside the migration path. Touched migration files have been linted as part of each step.
- Active code comments and older docs still mention `runAgentLoop` in historical context. That is expected in old plan docs and tests, but future docs should refer to AptKit runtime for active behavior.

## Recommended Next Steps

1. Decide packaging source for `@aptkit/core` in Blooming.
   Use a stable GitHub/package source instead of the temporary `/private/tmp` tarball before external install or deployment.

2. Audit `lib/mcp/tools.ts` against AptKit tool policies.
   Decide whether Blooming should keep local allowlists for route/API safety or import policy constants from AptKit where possible.

3. Classify eval scripts.
   Keep product-specific regression scripts in Blooming, but consider emitting AptKit-compatible replay artifacts so Studio/eval tooling can inspect them.

4. Decide legacy retention window.
   Keep legacy files until at least one real OpenAI/AptKit-backed end-to-end replay has been promoted and reviewed.

5. Update historical docs only where they confuse current behavior.
   Avoid rewriting old implementation plans wholesale; add short "current status" notes when needed.
