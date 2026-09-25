/** Pruebas unitarias y de contrato (sin base de datos). */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/', '\\.int\\.spec\\.ts$'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json', diagnostics: { ignoreCodes: [151002] } }] },
  // El cliente generado de Prisma importa con sufijo .js (resolución node16): se mapea a la fuente .ts SOLO en rutas relativas.
  moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' },
  clearMocks: true,
  // Piso de cobertura unitaria sobre TODO el código (la lógica de servicios la cubre sobre todo `npm run test:int`). Subirlo con cada mejora; nunca bajarlo.
  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**', '!src/**/*.spec.ts', '!src/tools/**', '!src/main.ts'],
  coverageThreshold: { global: { statements: 11, lines: 11, functions: 8, branches: 12 } },
}
