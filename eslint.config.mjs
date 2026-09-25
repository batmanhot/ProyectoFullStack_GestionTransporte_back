import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist', 'src/generated', 'node_modules', 'storage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Prompt §5: TypeScript estricto, sin any.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
    },
  },
  {
    // Nest resuelve la inyección por metadatos de tipos: las clases inyectadas deben importarse como valores.
    files: ['src/**/*.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
)
