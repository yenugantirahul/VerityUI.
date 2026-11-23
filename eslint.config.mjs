import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'data/**', 'coverage/**', 'web-dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
