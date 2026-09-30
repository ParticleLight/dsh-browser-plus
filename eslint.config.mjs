import tseslint from 'typescript-eslint'

/**
 * Deliberately small. The type-checked rules here catch defects that tests miss
 * (a floating promise nobody awaits, a promise handed to a callback that expects
 * void); formatting is left alone so the existing style is not churned.
 */
export default tseslint.config(
  { ignores: ['lib/**', 'node_modules/**', 'dist/**', 'build/**', '.wtcheck-*/**'] },
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      eqeqeq: ['warn', 'smart'],
    },
  },
)
