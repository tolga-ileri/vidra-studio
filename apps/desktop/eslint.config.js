import js from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["dist", "src-tauri", "node_modules", "playwright-report", "test-results"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-invalid-void-type": "off",
      "@typescript-eslint/no-dynamic-delete": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
    },
  },
  {
    // Node test helpers (mock provider server, fixture generator).
    files: ["**/*.{js,mjs}"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  }
)
