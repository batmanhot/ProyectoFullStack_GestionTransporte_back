/**
 * Pruebas de integración contra PostgreSQL REAL (API completa en proceso, Fastify inject).
 * Requiere DATABASE_URL de una BD de PRUEBA desechable: el setup la RESETEA (migrate reset + semilla DEMO).
 * Ejecutar: npm run test:int
 */
const base = require('./jest.config.js')
module.exports = {
  ...base,
  testMatch: ['**/*.int.spec.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  globalSetup: '<rootDir>/test/int/global-setup.ts',
  testTimeout: 60000,
}
