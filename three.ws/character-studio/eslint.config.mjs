import js from '@eslint/js';
import react from 'eslint-plugin-react';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'character-assets/', 'dist/', '**/*.png'] },
  {
    files: ['src/**/*.{js,jsx}'],
    ...js.configs.recommended,
  },
  {
    files: ['src/**/*.{js,jsx}'],
    ...react.configs.flat.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser,
    },
    settings: { react: { version: '19.2' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      'react/prop-types': 'off',
    },
  },
];
