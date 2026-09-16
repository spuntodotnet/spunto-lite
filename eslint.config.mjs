// `next lint` was removed in Next 16, and `npm run lint` still called it — so the check the
// dev workflow asks for on every PR (docs/dev-workflow.md) had been failing on every checkout.
// The linter is now ESLint's own CLI, which needs this file: there never was an .eslintrc here
// either, because `next lint` used to scaffold its config interactively. `eslint-config-next`
// 16 ships flat config directly, so no FlatCompat shim.
import coreWebVitals from "eslint-config-next/core-web-vitals"
import typescript from "eslint-config-next/typescript"

const config = [
  {
    // Build output, generated types, vendored SQL, and the e2e workspace — a separate npm
    // project with its own dependencies, which linting from here would resolve to nothing.
    ignores: [".next/**", "next-env.d.ts", "drizzle/**", "e2e/**", "local-https/**"],
  },
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      // Downgraded, not waived. This rule ships with eslint-plugin-react-hooks 7 — it is newer
      // than the six call sites it flags here, every one of them a pre-existing pattern it is
      // right about in principle (a mounted flag for hydration, a localStorage read on mount, a
      // form hydrated from a query). Fixing them means restructuring live components, which is
      // its own change and not one to smuggle into the PR that turned the linter back on: as a
      // warning each one still prints on every run, so the list is visible and shrinkable
      // instead of being the reason nobody runs `npm run lint` at all.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
]

export default config
