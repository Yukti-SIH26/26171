import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.output/**',
      '**/.wxt/**',
      '**/coverage/**',
      '**/web-ext-artifacts/**',
      '**/.cache/**',
      // Scratch space created by the editor's own tooling, not project source.
      'container_tools/**',
      // Bundled third-party binaries and their loaders: the ONNX Runtime wasm
      // glue, the Tesseract core, and its worker. All minified vendor output that
      // we ship verbatim and must not modify, so linting it produces thousands of
      // errors about code we do not own.
      'packages/*/src/public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      // Unused args are fine when prefixed with _, which is common in adapter
      // stubs that must satisfy an interface before they are implemented.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // This project handles secrets. An accidental console.log of a vault value
      // would be a real leak, so logging is opt-in per call site.
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: [
      '*.config.ts',
      '*.config.js',
      '*.config.mjs',
      '*.config.mts',
      'config/*.mts',
      'packages/*/wxt.config.ts',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Build tooling: runs in Node, so it legitimately uses console and process.
    files: ['**/scripts/**/*.mjs', '**/scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },
);
