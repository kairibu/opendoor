import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // `test-support.ts` predates this refactor and was part of the §2.2
      // baseline table, so it stays coverage-counted; `test-fixtures.ts` is
      // post-baseline and excluded so the totals stay byte-identical.
      // `doorstop-panel-element-test-support.ts` is the §6.3 split's test-only
      // scaffolding (post-baseline, like test-fixtures), so it is excluded too.
      // The `.json` entry is unreachable while `include` is `.ts`-only, but it
      // documents intent if the include ever widens.
      exclude: [
        "src/**/*.test.ts",
        "src/test-fixtures.ts",
        "src/browser/doorstop-panel-element-test-support.ts",
        "src/doorstop-state.fixtures.json",
      ],
    },
  },
});
