// vitest.eval.config.ts
//
// Separate vitest config for the eval harness. The default vitest.config.ts
// runs `test/**/*.test.ts` (the 221-test unit + integration suite); this one
// runs `eval/**/*.eval.ts` (the offline agent-quality harness).
//
// Two configs, not one, because:
//   · eval/ requires ANTHROPIC_API_KEY, costs money per run, and is
//     non-deterministic — it must stay out of `npm test`
//   · eval/ needs a longer per-test timeout (a 5-minute agent + judge cycle
//     vs the sub-second unit tests)
//
// Runner: `npm run eval` (→ `vitest run --config vitest.eval.config.ts`).

import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['eval/**/*.eval.ts'],
    testTimeout: 300_000, // 5 min per case — matches the 300s route budget
    hookTimeout: 60_000,
  },
});
