import js from '@eslint/js';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

const typescriptRecommended = tsPlugin.configs['flat/recommended'].map(config => ({
  ...config,
  files: config.files ?? ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
}));

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      'crisis_premium/css/**',
      'crisis_premium/assets/**',
      'prisma/migrations/**',
      'docs/**',
      'backups/**',
      '.claude/**',
      '.omx/**',
      'scratch/**',
      'stitch/**',
      'stitch_6/**',
      'autowebinar-production/**',
      'slides_data.mjs',
    ],
  },
  js.configs.recommended,
  ...typescriptRecommended,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-empty-function': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['crisis_premium/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        Hls: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
];
