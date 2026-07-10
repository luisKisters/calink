import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    // TypeScript files are type-checked by `tsc --noEmit` (stricter than ESLint).
    // @typescript-eslint is incompatible with TypeScript 7 (TS7 removed the old
    // compiler CJS API that @typescript-eslint@8.x relies on). Exclude .ts/.tsx
    // from ESLint until a compatible version is released.
    ignores: [
      ".next/**",
      "node_modules/**",
      "convex/_generated/**",
      "**/*.ts",
      "**/*.tsx",
    ],
  },
];
