# Registro de deuda técnica

Estado tras la auditoría de septiembre 2026 (actualizado tras implementar RLS). Lo resuelto queda al final; lo pendiente lleva criterio de cierre.

## Pendiente

| # | Deuda | Riesgo | Criterio de cierre |
|---|---|---|---|
| 3 | El modo demo del frontend (`src/core/demo`, ~3 500 líneas) reimplementa reglas del servidor; `core/domain/stops.ts` y `catalog.ts` divergen de las del backend. | Alto | Paquete de dominio compartido, o pruebas de contrato con fixtures comunes que fallen ante divergencias. |
| 4 | Servicios largos: `trips.service.ts` (~500 líneas), `platform-governance.service.ts`, `fleet.service.ts`; validaciones dentro de controladores. | Medio | Dividir por caso de uso; mover validaciones a DTOs. |
| 5 | Cobertura del backend: unitaria ~11 % de las líneas (sobre todo el código) y ~58 % de las sentencias con la suite de integración (32 casos). Módulos más débiles en integración: pasajeros (33 %), carga (40 %), plataforma (41 %), incidencias (45 %). | Alto | Pruebas para esos módulos; subir el piso de `jest.config.js` en cada mejora. |
| 6 | Reservas públicas con documento + apellido como única credencial. | Medio | Código de reserva u OTP. |
| 7 | Descarga de archivos sin control por recurso/alcance. | Medio | Vincular el archivo a su recurso y validar alcance en `downloadUrl`. |
| 8 | Jobs dentro de la API (candado consultivo). | Bajo | Proceso worker separado al escalar horizontalmente. |
| 9 | Datos desnormalizados en `Trip` (nombre de ruta, placa, conductor): son instantáneas al momento de la operación. | Bajo | Decisión de producto: mantener como historial (recomendado) y documentarlo en el modelo. |

## Resuelto
- **Aislamiento por tenant en PostgreSQL:** RLS activa y forzada en las 37 tablas con `tenantId` (+ `tenant`), dos roles de ejecución (`transportes_app` confinado; `transportes_platform` con BYPASSRLS y solo lectura sobre datos operativos), arranque fail-closed en producción, guarda de mismo-tenant en las 40 referencias entre tablas y `tenantId` inmutable. 11 pruebas de integración lo verifican, incluidas invariantes que fallan si una tabla o FK nueva queda sin protección.
- Secretos y cookie: sin `NODE_ENV` se asume producción; no se aceptan secretos de relleno.
- 64 claves foráneas nuevas (migración `referential_integrity`) con prueba de integración.
- Lecturas de `process.env` centralizadas y validadas en `app-config.ts`.
- CI del backend (`.github/workflows/quality.yml`) con PostgreSQL de servicio y suite de integración.
- Umbral de cobertura en Jest; `@nestjs/config` eliminada (sin uso). `@fastify/static` se conserva: la exige Swagger UI.
- Cuerpos vacíos con cualquier `Content-Type` toleran `{}`; cuentas bloqueadas ya no se distinguen por tiempo de respuesta.

## Notas operativas del aislamiento (no son deuda, sino contrato)
- Cada consulta del rol de la app corre dentro de una transacción con `set_config('app.tenant_id')`: añade viajes de ida y vuelta por consulta simple. Medir con carga real antes de producción; si pesa, agrupar lecturas en `PrismaService.tx()`.
- Las consultas crudas (`$queryRaw`) con el cliente `db` no fijan el tenant: ven cero filas por RLS. Úselas solo con `PrismaService.tx()`.
- Migrar exige el rol dueño (`MIGRATE_DATABASE_URL`); una migración que modifique datos de negocio debe tenerlo en cuenta (FORCE RLS aplica también al dueño no superusuario).
