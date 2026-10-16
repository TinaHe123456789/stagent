import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'web/dist/**', 'node_modules/**', 'coverage/**', 'test/fixtures/**', '.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 纯 JS 脚本运行在 Node 里。
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly' },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
