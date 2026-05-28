/**
 * Базовая конфигурация ESLint для backend на TypeScript + Node.js (ESM).
 * React в проекте нет, поэтому соответствующие плагины не подключаем.
 * Конфиг намеренно мягкий — задача гигиены, а не блокировки разработки.
 */
module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-empty-function': 'off',
    'no-empty': ['warn', { allowEmptyCatch: true }],
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'coverage/',
    'crisis_premium/',
    'prisma/migrations/',
    '.omx/',
    'scratch/',
    'stitch_/',
    'stitch_6/',
    'autowebinar-production/',
    'slides_data.mjs',
  ],
  overrides: [
    {
      files: ['tests/**/*.ts'],
      rules: {
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-non-null-assertion': 'off',
      },
    },
  ],
};
