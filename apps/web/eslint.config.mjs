// @ts-check
// Workspace-local mirror of the repo-root eslint.config.mjs.
//
// Why this file exists: the root config's `typescript-eslint` is resolved by pnpm
// against the ROOT `typescript` devDependency (7.0.2), and typescript-eslint hard-throws
// ("does not support TS 7.0") at module load for any TS >= 7 — see
// https://github.com/typescript-eslint/typescript-eslint/issues/10940. Because ESLint
// resolves config imports relative to the config file, a config living here picks up
// `apps/web`'s own typescript-eslint, which pnpm binds to this workspace's TS 5.9.3.
//
// Keep the rule set below in sync with the root eslint.config.mjs. Once typescript-eslint
// ships TS 7 support, this file can be deleted and the root config used again.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/generated/**',
      '**/node_modules/**',
      '**/coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
);
