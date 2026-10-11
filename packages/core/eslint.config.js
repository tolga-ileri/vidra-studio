import js from "@eslint/js"
import tseslint from "typescript-eslint"

export default tseslint.config(js.configs.recommended, ...tseslint.configs.strict, {
  rules: { "no-control-regex": "off" },
}, {
  // Tests index fixture arrays they just built.
  files: ["test/**"],
  rules: { "@typescript-eslint/no-non-null-assertion": "off" },
})
