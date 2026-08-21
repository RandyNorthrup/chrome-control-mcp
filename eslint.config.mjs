import js from "@eslint/js";
import globals from "globals";

const strictRules = {
  curly: ["error", "all"],
  eqeqeq: ["error", "always", { null: "ignore" }],
  "no-implicit-coercion": "error",
  "no-shadow": "error",
  "no-unused-vars": [
    "error",
    {
      argsIgnorePattern: "^_",
      caughtErrors: "all",
      caughtErrorsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
    },
  ],
  "no-var": "error",
  "object-shorthand": "error",
  "prefer-const": "error",
};

export default [
  {
    ignores: ["build*/**", "coverage/**", "dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  {
    files: ["browser/extension/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
      sourceType: "script",
    },
    rules: {
      ...strictRules,
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    files: ["**/*.mjs", "eslint.config.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "module",
    },
    rules: strictRules,
  },
];
