// Pre-commit runs on staged files only: autofix lint, then run the unit tests
// related to the staged sources. Heavier full typecheck + full test suite runs
// on pre-push and in CI (see .husky/pre-push and .github/workflows/ci.yml).
export default {
  '*.{ts,tsx}': ['eslint --fix', 'vitest related --run'],
}
