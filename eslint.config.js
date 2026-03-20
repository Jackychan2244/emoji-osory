import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "archive/**",
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "data/unicode/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
];
