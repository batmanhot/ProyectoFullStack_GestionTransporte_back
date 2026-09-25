# DOC-E-BE · Backend Engineering & API Architecture — Sistema de Gestión de Transportes

**Versión:** 1.0 · **Estado:** [VIGENTE CON CONTRATOS/SUPUESTOS PENDIENTES] · **Fecha:** 2026-09-24
**Estándar aplicado:** Prompt de ejecución *Backend Engineering & API Architecture v3.2*.
**Cadena:** DOC-A v1.0 → (DOC-B no entregado) → DOC-C-ARQ (ADR-001–015, vía DOC-D-FE) → DOC-D-FE v1.1 → **DOC-E-BE** → DOC-F-INT → DOC-G-SEC → DOC-H-QA → DOC-I-OPS.
**Código:** repositorio independiente del backend (separado del frontend). Este documento describe lo que el código **hace hoy** y verifica; lo pendiente se declara como tal.

**Verificación ejecutada (2026-09-24):** ESLint y TypeScript estricto sin errores · **53 pruebas unitarias** (7 suites) · **30 pruebas de integración** de la API completa contra PostgreSQL 18 real · migración aplicada sobre una base vacía sin *drift* respecto del esquema · semilla DEMO · arranque real de la API y recorrido de **48 verificaciones de humo** por HTTP (login, aislamiento, gate, SoD, idempotencia, outbox del conductor, telemetría, archivos, auditoría, plataforma).

---

## A. Pre-Check Backend

| Fuente | Evaluación | Estado |
|---|---|---|
| **DOC-A** (RF-001–032, PROC-001–009, ENT-001–020, RN, CTRL, EXC, ROL/PERM/POL/SOD, KPI, NFR, GAP) | Suficiente para el MVP y la Fase 2 funcional. Umbrales, volumetría, retención y normativa siguen abiertos (GAP-003/005/008/009/010). | ✅ con GAP declarados |
| **DOC-C-ARQ** | **No se entregó como documento independiente.** Se usaron los ADR-001–015 tal como los resume DOC-D-FE §B/§C (todos en estado **PROPUESTO**). Ninguna decisión del backend los contradice; hay 5 propuestas de cambio (§C.2). | ⚠ fuente secundaria |
| **DOC-D-FE** v1.1 | Entregado junto con el código del frontend. Se reconciliaron **todos** los FE-CONTRACT (§E): cada llamada de `src/core/repositories/http.ts` (repositorio del frontend) tiene su endpoint. | ✅ |
| **DOC-B** | No entregado. **PENDIENTE DE PLANIFICACIÓN**: no se inventan fases, sprints, fechas ni costos. | ⚠ no bloqueante |

**Dictamen del pre-check: ⚠ BACKEND READY CON CONTRATOS/SUPUESTOS PENDIENTES.**

Bloqueos **localizados** (no detienen el resto del backend):

| Bloqueo | Qué falta | Comportamiento actual |
|---|---|---|
| Respaldo y restauración por negocio (PC-A1 F2) | Estrategia de almacenamiento, retención y prueba de restauración (DOC-I-OPS) | `GET /platform/backups` lista metadatos; crear o restaurar responde `EXTERNAL_DEPENDENCY_UNAVAILABLE` **sin tocar datos** |
| Entrega por Email/Push/SMS (ADR-010) | Proveedor y plantillas (DOC-F-INT) | In-app entregado; modelo de entrega por canal y reintentos listo |
| Adaptador del proveedor GPS (INT-001, GAP-008) | Elegir proveedor | Contrato de ingesta neutral + credencial por negocio, funcionando |
| Almacenamiento de archivos (ADR-009) | Proveedor gestionado (DOC-I-OPS) | Puerto `ObjectStorage` + adaptador local (solo desarrollo) |
| Dominio comercial completo (FE-CONTRACT-016) | Catálogo de planes versionado, medición, facturación, impuestos, pagos | **No se implementa**: DOC-A no lo define y el prompt prohíbe inventarlo |

---

## B. Resumen de las fuentes

- **DOC-A:** producto B2B multi-tenant con aislamiento fuerte; el despacho depende del gate CTRL-001; lifecycle ≠ condiciones (DEC-002); alerta ≠ incidencia (DEC-004); frescura Actual / Desactualizada / No disponible (RN-005); reasignación con historia (RN-008); offline solo para el conductor (DEC-006); auditoría de acciones sensibles (NFR-005); metas de KPI pendientes.
- **DOC-C-ARQ (según DOC-D-FE):** monolito modular, REST `/api/v1` + OpenAPI, problem+json, sesión corta + refresh rotatorio en cookie, tenant por sesión (RLS), WebSocket scoped + REST de reconciliación, PWA con outbox, storage abstracto, notificaciones desacopladas, auditoría ≠ logs, `correlationId`, contratos versionados, integraciones por adaptadores.
- **DOC-D-FE:** 22 repositorios de contrato (FE-CONTRACT-001–031), un backend DEMO en el navegador que fija las reglas esperadas (gate, SoD, idempotencia, versión optimista, aislamiento) y sus propuestas de cambio a DOC-A (PC-A1…PC-A22) que el backend **implementa como supuestos declarados**.
- **DOC-B:** no existe; el orden de construcción siguió dependencias técnicas.

---

## C. Matriz ADR → Backend

| ADR | Impacto Backend | Decisión a respetar | Implementación BE | Estado |
|---|---|---|---|---|
| ADR-001 | Estructura | Monolito modular | NestJS con 19 módulos por contexto (`src/modules/*`); un proceso, una BD | ✅ |
| ADR-002 | API | REST `/v1`, acciones de lifecycle como endpoints, idempotencia, cursor en feeds | 128 operaciones; `POST /trips/{id}/{acción}`; `Idempotency-Key` en creaciones y acciones; auditoría por **cursor keyset**; catálogos y bandejas por página | ✅ |
| ADR-003 | Autenticación | Access token corto, refresh revocable en cookie, sin proveedor fijo | JWT HS256 (TTL configurable) + refresh **opaco** rotado en cada uso, guardado como SHA-256, cookie `HttpOnly; SameSite=Strict; Secure`; detección de reutilización | ✅ |
| ADR-004 | Autorización | permiso → alcance → política → SoD en backend | Guard de permiso (deny-by-default) + `DataScope` + políticas en dominio (SOD-001/002, POL-001/003/004, revisión senior) | ✅ |
| ADR-005 | Tenant | Tenant por sesión, nunca por cabecera; RLS | Extensión de Prisma **centralizada y fail-closed**; RLS preparado en `prisma/sql/rls-policies.sql` | ⚠ RLS sin activar (C.2-1) |
| ADR-006 | Tiempo / concurrencia | UTC, zona por tenant, versión optimista | `timestamptz`; `Tenant.timezone` expuesto en `Principal.timezone` (cierra FE-CONTRACT-031); `version` en vehículo, conductor, viaje, alertas, incidencias, carga, reservas y servicios | ✅ |
| ADR-007 | Tiempo real | WebSocket autenticado, solo notifica; REST reconcilia | `ws` en `/api/v1/realtime`, subprotocolo `bearer`, entrega filtrada por tenant, permiso y alcance, sin comandos entrantes, revalidación cada 60 s | ✅ (C.2-2) |
| ADR-008 | Offline del conductor | Outbox, sin despacho offline | `POST /driver/actions` exige `Idempotency-Key`; «Confirmada» o «Rechazada» definitiva y repetible; el inicio exige despacho autorizado y gate vigente | ✅ |
| ADR-009 | Archivos | Storage abstracto, URL temporal | Puerto `ObjectStorage`; subida directa con URL firmada (10 min), verificación de tamaño y firma binaria, descarga firmada (5 min) auditada | ⚠ proveedor pendiente |
| ADR-010 | Notificaciones | In-app base; entrega ≠ gestión | `notification` + `notification_delivery` por canal; deduplicación por regla | ⚠ otros canales pendientes |
| ADR-011 | Auditoría | Append-only con actor, antes/después, motivo y correlación | `audit_event` + **trigger que rechaza UPDATE/DELETE/TRUNCATE** (verificado); la plataforma ve solo metadatos | ✅ |
| ADR-012 | Observabilidad | `correlationId` extremo a extremo | `X-Correlation-Id` aceptado o generado, devuelto en cada respuesta, error y auditoría; métricas por ruta (plantilla, sin datos) | ✅ |
| ADR-013 | Errores | problem+json con códigos estables | `ProblemFilter` global (§W) | ✅ |
| ADR-014 | Versionado de clientes | Compatibilidad PWA ↔ API | `X-Client-Version` aceptado (y exigido en refresh/logout como defensa CSRF). Versión mínima: sin política | ⚠ C.2-4 |
| ADR-015 | Integraciones | Adaptadores; el negocio no conoce proveedores | Ingesta de telemetría con contrato neutral + `integration_credential` por negocio; puertos de almacenamiento y de canal | ✅ |

### C.2 Propuestas de cambio a DOC-C-ARQ

1. **ADR-005 · activación de RLS por etapas.** *Motivo:* el ADR pide RLS, pero exige un rol de BD sin `BYPASSRLS` ni propiedad de las tablas, `SET LOCAL app.tenant_id` en cada transacción y otro rol para plataforma y jobs. *Evidencia:* `prisma/sql/rls-policies.sql`. *Impacto:* BE/SEC/OPS. *Alternativa:* mantener el aislamiento en la aplicación (obligatorio, probado) y activar RLS como segunda capa cuando DOC-G-SEC y DOC-I-OPS definan los roles de BD.
2. **ADR-007 · autenticación del WebSocket (responde a DOC-D-FE C.2-1).** Se adopta el **subprotocolo `bearer`** que ya implementa el FE (el token no queda en la URL ni en logs). El ticket efímero por REST queda como mejora si DOC-G-SEC lo exige.
3. **ADR-002 · bandejas de gestión por página (acepta DOC-D-FE C.2-2).** Alertas, incidencias y listas usan página con orden por severidad; solo la auditoría usa cursor.
4. **ADR-014 · versión mínima de cliente.** Proponer `426 Upgrade Required` con código `CLIENT_VERSION_UNSUPPORTED` cuando `X-Client-Version` sea menor que la mínima configurada. Sin decisión no se aplica.
5. **Stack · NestJS 11.** El prompt exige NestJS 10+; NestJS 12 es solo ESM y Jest (obligatorio en el estándar) aún es inestable en ESM. Migrar a 12 cuando DOC-H-QA lo apruebe. Prisma 7.10 (estable); la etiqueta `latest` de npm apunta a una RC de Prisma 8.

---

## D. Mapa de módulos

| Módulo | Contexto DOC-A | Responsabilidad | Datos propietarios |
|---|---|---|---|
| `auth` | RF-032 · ADR-003 | Login por slug, refresh rotatorio, logout, aviso de suscripción | `auth_session` |
| `access` | M-002 · PROC-001 | Usuarios, roles, alcances, estructura organizacional, matriz rol→permiso | `app_user`, `user_role`, `user_scope`, `org_unit` |
| `platform` | M-001 · PC-A1 | Negocios, suscripciones, despliegue, SuperAdmins, cupos de administración, soporte SOD-003, salud, alertas de plataforma, roles, ajustes | `tenant*`, `support_*`, `role_override`, `platform_*`, `backup_record` |
| `fleet` | M-003 · PROC-002/008 | Vehículos, conductores, documentos, mantenimiento; elegibilidad | `vehicle`, `driver`, `compliance_document`, `maintenance_order` |
| `planning` | M-004 · PROC-003 | Rutas versionadas, servicios, viajes, gate CTRL-001, acciones, mensajería | `route`, `transport_service`, `trip*`, `gate_evaluation`, `dispatch_message` |
| `monitoring` | M-005 · PROC-004 | Posiciones y frescura, resumen, alertas, ingesta de telemetría, motor de alertas | `telemetry_event`, `vehicle_last_position`, `alert`, `integration_credential` |
| `incidents` | M-006 · PROC-007 | Incidencias y emergencias | `incident`, `incident_action` |
| `driver` | RF-027/028 | App del conductor (outbox) | — (usa planning/incidents) |
| `cargo` | M-007 · PC-A11 | Envíos, asignación con capacidad, entrega | `cargo_shipment`, `shipment_event` |
| `passengers` | M-008 · PC-A6/9/16 | Reservas por tramo, manifiesto, portal del pasajero | `passenger_booking`, `booking_event`, `passenger_profile` |
| `masters` | PC-A18/19 | Catálogos editables y maestro de clientes | `catalog_item`, `client_profile` |
| `public` | PC-A17/20 | Cartelera, «mi reserva», ajuste público del Login | — |
| `files` | ADR-009 | Reserva, subida, verificación y descarga de archivos | `stored_file` |
| `audit` | M-009 · RF-029/031 | Consulta, timeline por registro, exportación autorizada | `audit_event` |
| `analytics` | M-009 · §G | KPI-001–011 y panel | — |
| `notifications` | ADR-010 | Bandeja in-app | `notification`, `notification_delivery` |
| `realtime` | ADR-007 | Gateway WebSocket scoped | — |
| `jobs` | §N | Vencimientos, señal, retrasos, suscripciones, soporte, purga | `job_run` |
| `health` | prompt §30 | Liveness y readiness | — |

Profundidad de dominio proporcional: las reglas críticas viven en funciones **puras** y probadas (`fleet/domain/eligibility.ts`, `planning/domain/gate.ts`, `trip-rules.ts`, `stops.ts`, `platform/domain/subscription.policy.ts`, `monitoring/domain/geo.ts`); los servicios orquestan transacción, alcance, auditoría y efectos.

---

## E. Inventario de API reconciliado

Base `/api/v1`. **Auth** indica el permiso exigido (cualquiera de la lista) además de la sesión; el alcance se aplica siempre en el servicio. **Estado**: RECONCILIADO = coincide con el FE-CONTRACT; PROPUESTO = nuevo o ajustado por el backend (§F.3).

| API | RF / origen | ADR | FE-CONTRACT | Método y ruta | Auth | Estado |
|---|---|---|---|---|---|---|
| API-001 | RF-032 | 003 | 001 | `POST /auth/login` · `POST /auth/refresh` · `POST /auth/logout` | público (+ cookie; `X-Client-Version` en refresh/logout) | RECONCILIADO |
| API-002 | PC-A1 F4 | 003 | 014 | `GET /me/subscription-notice` | sesión | RECONCILIADO |
| API-003 | — | 003 | — | `POST /me/password` | sesión | PROPUESTO |
| API-004 | RF-032 | 004 | 002 | `GET/POST /users` · `PATCH /users/{id}` | `tenant.user.manage` | RECONCILIADO (+ `temporaryPassword`) |
| API-005 | RF-002 | 005 | 002 | `GET/POST /org-units` · `PATCH /org-units/{id}` | lectura: sesión · escritura: `organization.configure` | RECONCILIADO |
| API-006 | PC-A1 F3 | 004 | 002 | `GET /roles/matrix` | `tenant.user.manage` | RECONCILIADO |
| API-007 | RF-003/005 | 002/006 | 003 | `GET/POST /vehicles` · `PATCH /vehicles/{id}` · `POST /vehicles/{id}/block\|unblock\|service` | lectura: `vehicle.manage\|resource.eligibility.view\|trip.create` · bloqueo: `maintenance.manage` | RECONCILIADO |
| API-008 | RF-004/005 | 006 | 003 | `GET/POST /drivers` · `PATCH /drivers/{id}` · `POST /drivers/{id}/active` | `driver.manage` (lectura también `resource.eligibility.view\|trip.create`) | RECONCILIADO |
| API-009 | RF-007 | 009 | 003/030 | `GET/POST /documents` | `document.manage` (lectura ampliada) | RECONCILIADO |
| API-010 | RF-006 | 002 | 003 | `GET/POST /maintenance-orders` · `PATCH …/{id}` · `POST …/{id}/advance` | `maintenance.manage` | RECONCILIADO |
| API-011 | RF-002 | — | 003 | `GET /lookups/org` | sesión | RECONCILIADO |
| API-012 | RF-009 | 002 | 004 | `GET/POST /routes` · `POST /routes/{id}/retire` | `route.manage` (lectura ampliada) | RECONCILIADO |
| API-013 | RF-010–014 | 002/006 | 005 | `GET/POST /trips` · `GET /trips/{id}` · `POST /trips/{id}/assign` · `GET /trips/{id}/gate` | `trip.*` / `tracking.view` / `driver.own_trip.execute` | RECONCILIADO |
| API-014 | RF-012–014 | 002 | 005 | `POST /trips/{id}/enable\|dispatch\|arrival\|close\|cancel\|interrupt\|reassign\|reschedule` | permiso por acción (§H) | RECONCILIADO |
| API-015 | PC-A15 | 007 | — | `GET/POST /trips/{id}/messages` | lectura: dueño, `tracking.view` o `dispatch.message` · envío: `dispatch.message` | RECONCILIADO |
| API-016 | RF-008 · PC-A8 | — | — | `GET/POST /services` · `PATCH /services/{id}` · `POST /services/{id}/transition` | `service.manage` (lectura ampliada) | RECONCILIADO |
| API-017 | RF-016–017 | 007 | 006 | `GET /tracking/positions` · `GET /tracking/summary` | `tracking.view` | RECONCILIADO |
| API-018 | RF-018–020 | 010 | 006 | `GET /alerts` · `POST /alerts/{id}/acknowledge\|manage\|resolve\|close` | `alert.manage\|document.manage` | RECONCILIADO |
| API-019 | RF-015 · INT-001 | 015 | — | `POST /telemetry/positions` | `X-Integration-Key` del negocio | PROPUESTO |
| API-020 | RF-021/022 | 013 | 007 | `GET/POST /incidents` · `POST /incidents/{id}/actions\|advance` | `incident.manage` | RECONCILIADO |
| API-021 | RF-027/028 | 008 | 011 | `GET /driver/trips` · `POST /driver/actions` | `driver.own_trip.execute` | RECONCILIADO |
| API-022 | RF-023/024 · PC-A11 | — | — | `GET/POST /cargo-shipments` · `GET …/assignable-trips` · `PATCH …/{id}` · `POST …/{id}/assign\|advance` | `cargo.manage` | RECONCILIADO |
| API-023 | RF-025/026 · PC-A6 | — | — | `GET/POST /passenger-bookings` · `GET …/assignable-trips` · `PATCH …/{id}` · `POST …/{id}/advance` · `GET /trips/{id}/manifest` · `GET /passengers/lookup` | `passenger.manage` | RECONCILIADO |
| API-024 | PC-A9 | — | — | `GET /me/bookings` · `POST /me/bookings/{id}/cancel` | `passenger.portal` | RECONCILIADO |
| API-025 | PC-A18/19 | — | — | `GET/POST /catalog` · `PATCH /catalog/{id}` · `POST /catalog/{id}/active` · `GET /clients/lookup` | lectura: `cargo\|service.manage` · escritura: `organization.configure` | RECONCILIADO |
| API-026 | PC-A17/20 · PC-A1 | — | — | `GET /public/terminals` · `GET /public/schedule` · `POST /public/passenger-bookings/find` · `POST …/{id}/cancel` · `GET /public/settings/quick-access` | público, límite por IP | RECONCILIADO |
| API-027 | ADR-009 | 009 | 030 | `POST /files` · `POST /files/{id}/complete` · `GET /files/{id}/download-url` | permisos de documentos, incidencias, alertas o conductor | RECONCILIADO |
| API-028 | ADR-009 | 009 | 030 | `PUT/GET /files/blob/{token}` | token firmado (solo adaptador local) | PROPUESTO |
| API-029 | RF-029/031 | 011 | 008 | `GET /audit-events` (cursor) · `GET /audit-events/timeline` · `POST /exports` | `audit.view` · `report.export` | RECONCILIADO |
| API-030 | §G | — | 009 | `GET /kpis` · `GET /dashboard/overview` | `audit.view` | RECONCILIADO |
| API-031 | ADR-010 | 010 | 010 | `GET /notifications` · `POST /notifications/{id}/read` · `POST /notifications/read-all` | sesión | RECONCILIADO |
| API-032 | RF-001 · PC-A1 | 004/005 | 012/014/015 | `/platform/tenants[/{id}[/deployment\|subscription\|transition\|admins]]`, `/platform/tenant-admins`, `/platform/admins`, `/platform/support-sessions/*`, `/platform/health`, `/platform/overview`, `/platform/alerts/*`, `/platform/roles/*`, `/platform/settings`, `/platform/backups/*` | `platform.tenant.manage` **y** cuenta de plataforma | RECONCILIADO (backups: PENDIENTE OPS) |
| API-033 | prompt §30 | 012 | — | `GET /health` · `/health/live` · `/health/ready` | público | PROPUESTO |
| API-034 | ADR-007 | 007 | 013 | `WS /realtime` (subprotocolo `bearer`) | access token | RECONCILIADO |

El detalle de cada operación (request/response, códigos) está en `docs/openapi.json` (OpenAPI 3, 108 rutas / 128 operaciones).

---

## F. Contratos API definitivos

### F.1 Convenciones

| Tema | Decisión | Fuente |
|---|---|---|
| Base | `https://{host}/api/v1`, JSON UTF-8 | ADR-002 |
| Éxito | El **recurso directamente** (sin envoltorio `{data}`), como consume el FE (axios `.data`) | FE-CONTRACT (prevalece sobre el formato por defecto del prompt §9, que admite compatibilidad con DOC-D-FE) |
| Listas | `?page&pageSize(≤100)&search&sort=-campo&<filtro>=<valor>` → `{ items, total, page, pageSize, cutoffAt, overall, facets }`. `sort` y filtros con **lista blanca por endpoint** (sin inyección de campos) | ADR-002 · FE-CONTRACT-014 |
| Feeds | `?cursor&pageSize` → `{ items, nextCursor, totalApprox, cutoffAt, overall, facets }`; cursor opaco keyset `(at, id)` | ADR-002 |
| Errores | `application/problem+json` (§W) | ADR-013 |
| Fechas | ISO-8601 UTC; el negocio expone su zona en `Principal.timezone` | ADR-006 |
| Idempotencia | Cabecera `Idempotency-Key` (8–128 caracteres) | ADR-002 |
| Concurrencia | Campo `version` en el cuerpo de las actualizaciones; desfasado → 409 | ADR-006 |
| Correlación | `X-Correlation-Id` (opcional en la petición, siempre en la respuesta) | ADR-012 |
| Tenant | **Nunca** en cabecera ni en el cuerpo: sale de la sesión | ADR-005 |
| Borrado | No hay DELETE de negocio. Baja lógica por entidad (§F.2) | DOC-A |

### F.2 Semántica de «eliminar» (prompt §8)

| Entidad | Operación | Regla |
|---|---|---|
| Vehículo | *deactivate* (`/service`), bloqueo (`/block`) | No con viaje activo; bloqueo con motivo; liberación con SOD-002 |
| Conductor | *deactivate* (`/active`) | No con viaje activo |
| Documento | reemplazo | El anterior queda «Reemplazado» y su alerta de vencimiento se resuelve |
| Orden de mantenimiento | *cancel* | Con motivo; completadas o cerradas no se editan |
| Ruta | *archive* (`/retire` → Obsoleta) | No con viajes activos; editar = nueva versión |
| Viaje | *cancel* / *interrupt* / *reschedule* | Con motivo; reprogramar crea un viaje nuevo enlazado |
| Usuario | *deactivate* / bloqueo | Revoca sus sesiones al instante; nadie se desactiva a sí mismo |
| Negocio | suspender | Conserva datos; **cerrar bloqueado** (GAP-003) |
| Catálogo | *deactivate* | Sigue visible en registros previos |
| Auditoría | — | Inmutable (trigger) |

### F.3 Propuestas de ajuste de contrato (al FE)

1. **Contraseña temporal.** `POST /users`, `POST /platform/admins` y `POST /platform/tenants/{id}/admins` devuelven `temporaryPassword` **una sola vez** (nunca se guarda en claro ni se audita). Se propone `POST /me/password` para cambiarla. El FE hoy no la muestra.
2. **Vincular conductor o pasajero con su cuenta.** `POST /users` acepta `driverId` (ROL-008) y `document` (ROL-014); sin eso, un conductor no ve su app ni un pasajero sus reservas.
3. **Nuevos códigos de error:** `RATE_LIMITED` (429) y `NOT_FOUND` (404, solo rutas o acciones inexistentes). Hoy caen en la rama por defecto del FE sin romper nada.
4. **Principal.timezone** agregado (cierra FE-CONTRACT-031).
5. **Gate CAP-01 activo.** DOC-D-FE lo marcaba «No aplica (Fase 2)»; con Carga y Pasajeros implementados, RN-003/RN-004 (CONFIRMADAS en DOC-A) se revalidan al habilitar y despachar. `MFT-01` sigue «No aplica» (GAP-007).
6. **Cierre de viaje con manifiestos pendientes → 409.** DOC-A PROC-003 exige completar desembarque y entregas antes de cerrar; el demo del FE no lo validaba.
7. **Reprogramar** asigna un **código nuevo** (`VJ-10xx`) enlazado al original, en vez del sufijo `-R`.
8. **Respaldos** (`POST /platform/backups`, `/restore`) responden 503 hasta DOC-I-OPS.
9. **Conductores**: la vista incluye `trainingPending` y `aptitudePending` (los usa el formulario del FE).

---

## G. Authentication

| Aspecto | Implementación |
|---|---|
| Login | `slug` del negocio + correo + contraseña (PC-A22: correo único **por negocio**, índice parcial en BD). Sin slug = cuenta de plataforma. El mismo mensaje para slug, correo o contraseña incorrectos, con tiempo de respuesta igualado |
| Hash | `PasswordHasher` (abstracción) → bcrypt, costo configurable (`BCRYPT_COST`) |
| Access token | JWT HS256, `sub` + `sid` (familia de sesión) + `typ`; TTL `ACCESS_TOKEN_TTL_SECONDS` (por defecto 900 s, **SUPUESTO**) |
| Refresh | Token opaco de 256 bits, solo su SHA-256 en `auth_session`; cookie `HttpOnly; SameSite=Strict; Secure` en `/api/v1/auth`; TTL `REFRESH_TOKEN_TTL_DAYS` (7, **SUPUESTO**); rotación en cada uso |
| Robo de refresh | Reutilizar un refresh ya rotado **revoca toda la familia** (salvo una carrera benigna de 10 s entre pestañas) |
| Revocación inmediata | El principal se reconstruye en cada petición: logout, cuenta desactivada, negocio suspendido o suscripción bloqueada cortan el acceso sin esperar al vencimiento del token |
| Bloqueo por intentos | `LOGIN_MAX_FAILED` (5) → `LOGIN_LOCK_MINUTES` (15). **SUPUESTO** |
| Límite por IP | Login `AUTH_RATE_LIMIT_PER_MIN` (20/min por defecto) |
| CSRF | Cookie `SameSite=Strict` + cabecera `X-Client-Version` obligatoria en refresh y logout |
| Política de contraseña | ≥ 8 caracteres con letras y números (**SUPUESTO**; MFA y política final → DOC-G-SEC) |

---

## H. Authorization / Policies

Tres capas, siempre en el servidor:
1. **Permiso** (`@RequirePermission`, guard global): la matriz rol→permiso de DOC-A §J.2 más las personalizaciones del SuperAdmin (`role_override`). Toda denegación se audita (`access.denied`, Seguridad).
2. **Alcance** (`DataScope`): TENANT/ORGANIZATION = todo el negocio; BASE y FLEET = sus terminales y flotas; OWN_RECORDS = conductor y pasajero; CUSTOMER_ORG = cliente. Un recurso fuera de alcance responde **igual que uno inexistente** (403 «Recurso no disponible»).
3. **Política de dominio:**

| Regla | Dónde | Comportamiento |
|---|---|---|
| CTRL-001 / RN-001 · POL-001 | `TripsService.act(enable\|dispatch)` | Gate evaluado al habilitar **y otra vez al despachar**; crítico fallido → 422 `GATE_NOT_SATISFIED` con el detalle; la evaluación fallida se registra (KPI-004) |
| SOD-001 | `dispatch` | Quien creó el viaje no lo despacha; excepción solo ROL-003 y administradores del negocio (PC-A1), con motivo ≥ 10 y auditada (`sod.exception`) |
| SOD-002 | `unblock` | Quien bloqueó no libera, salvo ROL-003 o administrador del negocio |
| SOD-003 | `platform/support-sessions` | Caso + motivo + alcance + ≤ 8 h (CHECK en BD) + revocable; auditado en la plataforma **y** en el negocio |
| POL-002 | `tracking`, `alerts`, `trips` | Visibilidad por alcance |
| POL-003 | `reassign` | Motivo ≥ 10; en ruta exige evidencia; conserva la asignación anterior (RN-008) |
| POL-004 / CTRL-026 | `POST /exports` | Exige permiso de lectura del recurso; la **sensibilidad la decide el servidor** |
| CTRL-013 | cierre de alerta Alta/Crítica | Solo ROL-010, ROL-003 o administradores del negocio |
| CTRL-021 | cierre de incidencia | Exige resolución o evidencia; Alta/Crítica exige revisión senior |
| RN-010 | usuarios | Un negocio no asigna roles de plataforma ni los cupos ROL-002/015 |
| Plataforma | `PlatformAccountGuard` | Además del permiso, la cuenta debe ser de plataforma (sin tenant) |

**Supuestos heredados de DOC-D-FE (PROPUESTA DE CAMBIO A DOC-A):** PC-A1 (ROL-015 y ROL-002 ampliado), PC-A4 (ROL-003 recibe PERM-005), PC-A5 (ROL-001 recibe PERM-027), PC-A6 (ROL-012 recibe PERM-027), PC-A9 (PERM-028 `passenger.portal`), PC-A15 (PERM-029 `dispatch.message`). El «modo construcción / CRUD abierto» del FE **no existe en el backend**.

---

## I. Tenant Context / Isolation

1. **Resolución:** `AuthGuard` → `PrincipalLoader` → `RequestContext` (AsyncLocalStorage). El tenant sale del registro del usuario autenticado, nunca de la petición.
2. **Aplicación centralizada:** `database/tenant-isolation.extension.ts` intercepta **todas** las operaciones de Prisma sobre 32 modelos de negocio: agrega `tenantId` a los `where`, lo fija en las creaciones, **rechaza** filtros o datos con otro tenant y **falla cerrado** si no hay tenant en contexto. Los servicios no «recuerdan» filtrar: no pueden olvidarlo.
3. **Acceso sin tenant, deliberado y acotado:** `PrismaService.system` solo en autenticación, consola de plataforma, jobs (que entran al contexto de cada negocio con `RequestContext.asTenant`) y endpoints públicos (confinados a `PUBLIC_TENANT_SLUG`).
4. **Defensa en profundidad:** RLS preparado (`prisma/sql/rls-policies.sql`), no activado (C.2-1).
5. **Integridad en BD:** correo único por negocio, una suscripción vigente por negocio, una incidencia abierta por alerta, una alerta abierta por regla, un único SuperAdmin Nativo (índices únicos parciales).
6. **Verificado:** otro negocio no ve, no edita, no acciona ni lee mensajes de recursos ajenos; la auditoría de un negocio solo contiene sus eventos; una `Idempotency-Key` compartida no cruza usuarios; el canal WebSocket no entrega eventos de otro tenant.

---

## J. SuperAdmin / Administración de negocios

| Perfil | Rol | Reglas enforzadas |
|---|---|---|
| SuperAdmin Nativo | ROL-001, `isNative` | Único (índice parcial). Nadie lo edita, degrada ni desactiva |
| SuperAdmin Delegado | ROL-001 | Máximo 2; solo el Nativo los crea, edita, activa o desactiva; desactivar revoca sus sesiones |
| Admin Owner | ROL-015 | Un titular activo por negocio; lo asigna el SuperAdmin |
| Admin Tenant | ROL-002 | Un titular activo por negocio; lo asigna el SuperAdmin; administra usuarios y estructura, sin acceso a plataforma |
| Usuarios de negocio | ROL-003…014 | Asignados por el Admin del negocio |

La plataforma **gobierna, no opera**: lee contadores y metadatos de auditoría, nunca contenido de un negocio (EXC-032). El diagnóstico de soporte solo existe con una sesión SOD-003 activa y devuelve cifras agregadas.

---

## K. Plans / Subscriptions

- **Suscripción** (`tenant_subscription`): plan, ciclo, inicio y fin; cada renovación agrega una fila y conserva el historial (un solo registro `current`).
- **Estado calculado, no booleano** (`subscription.policy.ts`): Activa → Por vencer (últimos N días) → En gracia (N días con acceso) → Bloqueada. N = `graceDays` (0–60, por defecto 5, **SUPUESTO**). Renovar reactiva al instante. **Nunca se borran datos.**
- **Enforcement en autenticación y en cada petición**, con `TENANT_CONTEXT_INVALID` y `extensions.subscriptionExpired`.
- **Avisos:** notificación in-app deduplicada por fase y vencimiento (job horario y al iniciar sesión) y señales en el Centro de alertas de plataforma.
- **Planes, precios, límites y facturación: PENDIENTES** (FE-CONTRACT-016). DOC-A no los define; no se inventan precios, límites ni impuestos. El plan se valida contra el catálogo cerrado `Starter | Business | Enterprise` y la modalidad de despliegue exige Enterprise fuera de SaaS.

---

## L. Audit Trail

Campos: `id, at, kind (Negocio|Seguridad), tenantId, actorUserId, actor, actorRoles, resourceType, resourceId, action, result (OK|DENEGADO|ERROR), reason, before, after, correlationId, ip, userAgent`. Textos recortados a 500 caracteres, sin secretos (las contraseñas temporales nunca se auditan).

- **Atómica:** los servicios pasan su transacción, así que acción y registro se confirman o revierten juntos. Las denegaciones se registran fuera de la transacción para que el rechazo no las borre.
- **Append-only en la BD:** trigger que rechaza UPDATE, DELETE y TRUNCATE (verificado).
- **Cubre:** login (ok, fallido, bloqueado, denegado), logout, reutilización de refresh, `access.denied`, SoD (violación y excepción), cambios de usuarios, roles y matriz, todo el ciclo de viajes, gate rechazado, bloqueo y liberación, documentos, alertas, incidencias, carga, reservas, archivos (subida y descarga), exportaciones, soporte, suscripciones, ajustes, SuperAdmins y cupos.
- **Consulta:** cursor keyset; facetas por tipo y por denegación, exportación y excepción; timeline por registro.

---

## M. Notifications

`NotificationService.notify()` crea la notificación dentro de la transacción del caso de uso y devuelve la publicación en tiempo real para **después del commit**. Entrega por canal en `notification_delivery` (Entregada, Pendiente o Fallida, con intentos y próximo intento). Solo el canal **In-app** tiene adaptador. Email, Push y SMS se agregan como adaptadores cuando DOC-F-INT elija proveedor; no se elige proveedor aquí.

Eventos que notifican: viaje despachado, reasignado o interrumpido; checklist con fallas; incidencia o emergencia; alertas creadas o escaladas; vencimiento de documentos; aviso de suscripción.

---

## N. Background Jobs

Abstracción `JobRunner`: en proceso con `@nestjs/schedule` (sin Redis ni BullMQ, porque no hay decisión de infraestructura), **exclusión mutua entre réplicas** con índice único parcial `job_run(job) WHERE status='RUNNING'` (seguro con pool de conexiones) y recuperación de ejecuciones colgadas a los 15 min. Cada ejecución queda en `job_run` y alimenta la salud de plataforma. `JOBS_ENABLED=false` los desactiva.

| Job | Frecuencia (SUPUESTO) | Regla |
|---|---|---|
| `documents.expiry` | 10 min | PC-A7 / CTRL-005/023: una alerta por documento, escalada al empeorar, con responsable asignado |
| `tracking.signal` | 1 min | EVT-004 / RN-005: en ruta con GPS sin reportar durante `SIGNAL_LOST_SECONDS` → «Sin señal»; se resuelve sola al recuperar señal |
| `trips.delay` | 5 min | CTRL-008: ETA vigente superada más `DELAY_TOLERANCE_MINUTES` → «Retraso» |
| `subscriptions.notices` | 1 h | Aviso previo y de gracia |
| `support.expiry` | 1 min | Expira sesiones SOD-003 |
| `idempotency.purge` | 1 h | Borra claves vencidas (48 h) |

Todos son idempotentes (`dedupeKey` más índice parcial): reejecutarlos no duplica nada.

---

## O. Data Model / Prisma

`prisma/schema.prisma` (Prisma 7, generador `prisma-client` CJS, adaptador `@prisma/adapter-pg`). Tablas en snake_case y valores de enum guardados con la **etiqueta de negocio de DOC-A** (`@map`), así que la BD se lee igual que la UI. DTO de API, dominio y persistencia están separados (`labels.ts` traduce; ninguna columna interna, como hashes, `dedupeKey` o `storageKey`, sale en la API).

| ENT (DOC-A) | Modelo(s) |
|---|---|
| ENT-001 Tenant | `Tenant`, `TenantSubscription`, `TenantDeployment` |
| ENT-002/003 Organización / base / unidad | `OrgUnit` (Base = terminal, con ciudad y dirección, PC-A12) |
| ENT-004 Flota | `OrgUnit` tipo Flota |
| ENT-005 Vehículo | `Vehicle` |
| ENT-006 Conductor | `Driver` (enlace opcional a `User`) |
| ENT-007 Documento | `ComplianceDocument` (reemplazo, no edición) |
| ENT-008 Inspección / mantenimiento | `MaintenanceOrder` |
| ENT-009 Servicio | `TransportService` |
| ENT-010/011 Ruta / geocerca | `Route` (puntos y geocercas inmutables por versión) |
| ENT-012 Viaje | `Trip`, `TripEvent` |
| ENT-013 Asignación | `TripAssignment` (historial RN-008) |
| ENT-014 Posición / evento | `TelemetryEvent`, `VehicleLastPosition` |
| ENT-015 Alerta | `Alert` |
| ENT-016 Incidencia | `Incident`, `IncidentAction` |
| ENT-017 Carga | `CargoShipment`, `ShipmentEvent`, `ClientProfile` |
| ENT-018 Pasajero | `PassengerBooking`, `BookingEvent`, `PassengerProfile` |
| ENT-019 Auditoría | `AuditEvent` |
| ENT-020 KPI | calculado (sin tabla) + `GateEvaluation` como evidencia |
| Transversal | `User`, `UserRole`, `UserScope`, `AuthSession`, `IdempotencyRecord`, `Notification*`, `StoredFile`, `CatalogItem`, `IntegrationCredential`, `TenantCounter`, `JobRun`, `SupportSession/Interaction`, `RoleOverride`, `PlatformSettings`, `PlatformAlertState`, `BackupRecord` |

Las condiciones operacionales (Retrasado, Con alerta, Con incidencia, Sin señal, En riesgo; Bloqueado, Documento vencido…) **no se persisten**: se derivan al leer desde alertas, incidencias y documentos, así que al cerrar la causa la condición desaparece sola.

---

## P. Transaction Boundary Matrix

| UC / RF | Entidades en la misma transacción | Atomicidad | Concurrencia | Evento posterior (tras commit) | Rollback |
|---|---|---|---|---|---|
| Planificar viaje (RF-010/011) | trip, trip_event, trip_assignment, tenant_counter, audit | todo o nada | `FOR UPDATE` en vehículo y conductor → RN-002 sin carreras (verificado con 2 peticiones simultáneas) | `trip.updated` | no se crea nada; el código no se «quema» |
| Asignar / reasignar (RN-008) | trip (versión), trip_assignment, bookings/cargo (placa), trip_event, notification, audit | todo o nada | versión optimista + `FOR UPDATE` | `trip.updated`, notificación | estado anterior intacto |
| Habilitar / despachar (CTRL-001) | trip, gate_evaluation, trip_event, notification, audit | todo o nada | versión opcional | `trip.updated` | la evaluación **fallida** se persiste aparte (KPI-004) |
| Cerrar viaje | trip, vehicle (lifecycle), trip_event, audit | todo o nada | — | `trip.updated` | — |
| Cancelar viaje (EXC-009) | trip, bookings (→ Cancelada), cargo (→ Registrada), trip_event, audit | todo o nada | — | `trip.updated` | — |
| Reprogramar (RF-014) | viaje nuevo, viaje original, bookings/cargo movidos, eventos, audit | todo o nada | `FOR UPDATE` recursos | `trip.updated` | — |
| Renovar documento (RN-009/PC-A7) | documentos (reemplazo), alertas (→ Resuelta), vehicle (Disponible), audit | todo o nada | — | — | — |
| Reservar pasajero (RN-003) | booking, booking_event, passenger_profile, counter, audit | todo o nada | `FOR UPDATE` del viaje → sin doble asiento | — | — |
| Asignar carga (RN-004) | cargo, shipment_event, audit | todo o nada | `FOR UPDATE` del vehículo → la suma de pesos no se excede | — | — |
| Crear incidencia / emergencia | incident, alert (vínculo), trip_event, notification, audit | todo o nada | índice parcial EXC-025 | `incident.emergency`, notificación | — |
| Alta de negocio (PC-A1) | tenant, subscription, deployment, 2 usuarios, roles, scopes, catálogos, audit | todo o nada | unicidad de nombre y slug | — | — |
| Renovar suscripción | subscriptions (anterior → no vigente, nueva), audit | todo o nada | índice parcial «una vigente» | — | — |
| Suspender negocio | tenant, auth_session (revocadas), audit | todo o nada | — | — | — |
| Telemetría (por evento) | telemetry_event, last_position, vehicle (odómetro), alertas, trip_event, notification | por evento (un evento inválido no descarta el lote) | único (vehículo, instante) | `position.updated`, `alert.created` | — |

---

## Q. Concurrency Matrix

| Entidad | Riesgo | Técnica | `version` | Lock | Contrato de conflicto |
|---|---|---|---|---|---|
| Viaje | Alto (varios roles lo operan) | Optimista + locks de recurso | sí | `FOR UPDATE` vehículo/conductor/viaje | 409 `RESOURCE_CONFLICT` «Versión desactualizada» o «Conflicto de asignación (RN-002)» |
| Vehículo / conductor | Medio | Optimista (`updateMany where version`) | sí | — | 409 |
| Reservas de un viaje | Alto (asientos) | Lock pesimista del viaje | sí | `FOR UPDATE trip` | 422 por campo (asiento, tramo) |
| Carga de un vehículo | Medio (capacidad) | Lock pesimista del vehículo | sí | `FOR UPDATE vehicle` | 422 por campo (capacidad) |
| Alertas / incidencias | Medio | Transiciones por estado + índices parciales | sí | — | 409 «Estado inválido» / «Incidencia duplicada» |
| Refresh token | Alto (robo o pestañas) | `updateMany where rotatedAt null` | — | — | 401 + revocación de familia |
| Jobs | Réplicas | Lease con índice parcial | — | — | la réplica perdedora no ejecuta |
| Contadores de código | Alto | `INSERT … ON CONFLICT DO UPDATE … RETURNING` | — | fila | — |
| Offline del conductor | Reintentos | Idempotencia + «server wins» | — | — | «Rechazada» definitiva con motivo |

No hay last-write-wins silencioso en ninguna entidad crítica.

---

## R. Idempotency

- **HTTP genérico:** `@Idempotent()` en creaciones y acciones. Clave aislada por **tenant + usuario + clave**; hash SHA-256 de la intención canónica (método, ruta, parámetros y cuerpo con claves ordenadas). Si la operación terminó, se devuelve la respuesta guardada (con `Idempotent-Replayed: true`, verificado); otra intención con la misma clave → 409 `IDEMPOTENCY_CONFLICT`; si sigue en curso → 409; si el caso de uso falla, la reserva se libera. Vigencia de 48 h (**SUPUESTO**: cubre una jornada sin señal) y purga horaria.
- **Conductor:** la clave es **obligatoria**; la respuesta «Rechazada» se guarda igual que la «Confirmada» (el outbox no reintenta en bucle).
- **Telemetría:** único `(vehicleId, sourceTime)`.
- **Reglas de detección:** `dedupeKey` más índice parcial «una alerta abierta por condición».
- **Notificaciones:** `(tenantId, dedupeKey)` único.

---

## S. KPI / Aggregation endpoints

`GET /kpis?period=7d|30d[&baseId]` devuelve KPI-001…011 con fórmula literal de DOC-A, proceso, unidad, valor, `sufficientData`, **tendencia diaria real** (hasta 14 días), `target: null` (todas las metas están [META PENDIENTE]), período, corte, `drillTo`, fase y polaridad. Sin datos suficientes → `value: null` (el FE muestra «—», EXC-031). Los viajes sin GPS no cuentan para KPI-008/009 (DOC-A: la ausencia de GPS no es velocidad cero).

`GET /dashboard/overview` agrega el panel en una sola llamada (mosaicos, pipeline, serie diaria, alertas por severidad y tipo, elegibilidad, vencimientos, listas priorizadas, bloque de Fase 2 según permisos) sobre el alcance del usuario. KPI-012 (aislamiento) aparece en `/platform/health` como `isolationIncidents`.

---

## T. Files / Documents

Metadatos en `stored_file` (dueño = tenant + usuario que sube, estado, tamaño, tipo, clave de almacenamiento). Permitidos PDF, JPG y PNG hasta 5 MB, validados en el DTO, en la URL firmada (tipo y tamaño exactos) y por **firma binaria** (un `.exe` renombrado a `.pdf` se rechaza, verificado). Relación con documentos (`fileId`), alertas e incidencias (`evidenceFileIds`). Subida y descarga auditadas. El nombre visible se sanea (sin rutas ni caracteres de control). Versionado = reemplazo del documento (RN-009). **Proveedor de almacenamiento: PENDIENTE** (DOC-I-OPS); en producción debe tener cifrado en reposo y reemplazar el adaptador local.

---

## U. Migrations

`prisma/migrations/20260924000000_init/migration.sql`: DDL generado por Prisma más SQL escrito a mano: trigger append-only de auditoría, 7 índices únicos parciales, CHECK de integridad (capacidades ≥ 0, ETA > salida, vigencia > emisión, archivo ≤ 5 MB, soporte ≤ 8 h, gracia 0–60) y la fila de ajustes. Verificado: se aplica sobre una base vacía y `prisma migrate diff` no detecta *drift*.

Principios: migraciones incrementales y no destructivas; `migrate deploy` en todos los entornos salvo desarrollo; ningún DROP de columnas con datos sin plan de transformación; respaldo previo a cada despliegue (DOC-I-OPS); la reversión operativa se hace con una migración compensatoria, no editando migraciones aplicadas.

---

## V. Seeds / DEMO

`prisma/seed.ts` **se niega a correr en producción**. Crea el SuperAdmin Nativo, tres negocios (**andina** completo, **sur** completo para probar el aislamiento y **delta** suspendido para EXC-002), usuarios por **rol real de DOC-A** con su alcance normal (incluye un despachador con alcance Base Sur), conductores (uno con licencia vencida, uno con capacitación pendiente), vehículos Elegible, Condicionado, No habilitado y Bloqueado, documentos por vencer y vencidos, una orden crítica, rutas con paradas, viajes en todo el lifecycle (en ruta, asignado con advertencias, asignado no habilitado, planificado, listo para salir), posición GPS, alerta, incidencia y una credencial de telemetría. Contraseña DEMO configurable (`SEED_DEMO_PASSWORD`). Es idempotente por slug.

---

## W. Error model

`application/problem+json`:

```json
{ "type": "https://transportes.local/problems/gate-not-satisfied", "title": "Viaje no habilitado", "status": 422,
  "code": "GATE_NOT_SATISFIED", "detail": "…", "correlationId": "…", "errors": [{ "field": "…", "message": "…" }], "extensions": { "gate": { … } } }
```

| Código | HTTP | Cuándo |
|---|---|---|
| `VALIDATION_ERROR` | 422 (400 JSON inválido, 413 tamaño) | Estructura (class-validator, campos desconocidos rechazados) o regla con campo |
| `UNAUTHENTICATED` | 401 | Sin sesión, token vencido o revocado, credenciales |
| `FORBIDDEN` | 403 | Sin permiso, fuera de alcance o **inexistente** (no se distingue), SoD (`extensions.rule`), intento cross-tenant |
| `TENANT_CONTEXT_INVALID` | 403 | Negocio suspendido o suscripción bloqueada (`extensions.tenantStatus` o `subscriptionExpired`) |
| `RESOURCE_CONFLICT` | 409 | Estado inválido, versión desactualizada, RN-002, duplicados, operación en curso |
| `GATE_NOT_SATISFIED` | 422 | Gate CTRL-001 con crítico fallido (`extensions.gate`) |
| `IDEMPOTENCY_CONFLICT` | 409 | Clave reutilizada con otra intención |
| `EXTERNAL_DEPENDENCY_UNAVAILABLE` | 503 | Dependencia no disponible (respaldos pendientes de OPS) |
| `RATE_LIMITED` | 429 | Límite de frecuencia (PROPUESTO al FE) |
| `NOT_FOUND` | 404 | Ruta o acción de API inexistente (PROPUESTO) |
| `INTERNAL_ERROR` | 500 | Inesperado: sin traza, SQL ni nombres internos; detalle solo en el log con el `correlationId` |

---

## X. Testing

| Nivel | Qué cubre | Resultado |
|---|---|---|
| Unitarias (`npm test`, 53 pruebas) | Gate CTRL-001 (11 casos: advertencia ≠ crítico, reemplazo, mantenimiento vencido o futuro, inspección, capacidad), elegibilidad y lifecycle derivado, matriz de transición, condiciones, tramos y asientos, política de gracia, **extensión de aislamiento** (inyección, rechazo cross-tenant, fail-closed), contrato de listas y cursor, hash de idempotencia, mapeo de errores sin fuga de detalles, startup checks, matriz rol→permiso (sin permisos huérfanos), audiencia del tiempo real, firmas de archivo, frescura | ✅ 53/53 |
| Integración (`npm run test:int`, 30 pruebas, PostgreSQL real) | Login indistinguible, correo por negocio, suspendido, rotación y reutilización de refresh, logout con revocación inmediata, denegación auditada, alcance BASE, RN-010/PC-A1, **aislamiento** (lectura, edición, acción, mensajes, auditoría, idempotencia), RN-002 con **carrera concurrente real**, gate sin transición parcial y evaluación persistida, SOD-001 con excepción, EVT-008, versión optimista, SOD-002, outbox del conductor, telemetría idempotente, CTRL-013, PC-A7 (job + resolución al renovar), restricciones del Nativo y los Delegados, EXC-032, GAP-003, suspensión y reactivación, bloqueo por suscripción y renovación, ROL-001 no editable, forma `Page<T>` en 12 listas, correlación en errores, POL-004, portal | ✅ 30/30 |
| Humo (API real por HTTP) | 48 verificaciones de extremo a extremo, incluida la subida directa y la descarga firmada | ✅ 48/48 |

**Brechas declaradas:** sin pruebas de carga (los objetivos de NFR-004/008 están pendientes por GAP-005; no se inventan umbrales: **[SUPUESTO TÉCNICO DE QA]** pendiente), sin pruebas automáticas del WebSocket de extremo a extremo (sí de la regla de audiencia), sin pruebas de contrato generadas desde OpenAPI contra el FE (recomendado para DOC-H-QA). No se fija un porcentaje de cobertura como criterio único.

---

## Y. Deployment Contract (sin DevOps)

| Ítem | Valor |
|---|---|
| Runtime | Node.js ≥ 22 (probado en 24), PostgreSQL ≥ 14 (probado en 18) |
| Puerto | `PORT` (3000); escucha en `0.0.0.0` |
| Health | `GET /api/v1/health` (BD), `/health/live`, `/health/ready` (503 si no hay BD) |
| Orden | `npm ci` → `npm run db:migrate:deploy` → `npm run build` → `npm start`. Migrar **antes** de arrancar la nueva versión. Nunca `db:seed` en producción |
| Startup checks | La configuración se valida al arrancar: en producción exige `JWT_ACCESS_SECRET` y `FILES_SIGNING_SECRET` reales (≥ 32 caracteres, distintos del ejemplo) y `COOKIE_SECURE=true`; conecta a la BD antes de aceptar tráfico |
| Secretos | `DATABASE_URL`, `JWT_ACCESS_SECRET`, `FILES_SIGNING_SECRET`; claves de integración (se guardan hasheadas) |
| Variables | Ver `.env.example`: CORS, TTL de sesión, bcrypt, bloqueo, umbrales GAP-009 (`POSITION_FRESH_SECONDS`, `SIGNAL_LOST_SECONDS`, `DOC_EXPIRING_DAYS`, `SPEED_TOLERANCE_PCT`, `DELAY_TOLERANCE_MINUTES`, `ARRIVAL_ON_TIME_TOLERANCE_MINUTES`, `ROUTE_CORRIDOR_METERS`), `DEFAULT_TIMEZONE`, almacenamiento, `JOBS_ENABLED`, `SWAGGER_ENABLED`, `PUBLIC_TENANT_SLUG`, `AUTH_RATE_LIMIT_PER_MIN`, `TRUST_PROXY` |
| Dependencias externas | PostgreSQL. Pendientes de elección: almacenamiento de objetos, canal de notificación, proveedor GPS y cartográfico |
| Réplicas | Stateless salvo tres puntos: los jobs se coordinan por BD; el rate limit y las métricas son por réplica (en memoria); el WebSocket requiere afinidad o un bus compartido si hay varias réplicas → decisión de DOC-I-OPS |
| Proxy | `TRUST_PROXY=true` solo detrás de un proxy confiable (afecta la IP de auditoría y del rate limit) |

---

## Z. Quality Gate

| Criterio | Resultado |
|---|---|
| **Arquitectura:** ADR aplicables identificados y respetados; desviaciones como propuesta | ✅ 15 ADR mapeados; 5 propuestas (C.2); DOC-C-ARQ usado vía DOC-D-FE (⚠ fuente secundaria) |
| **Trazabilidad:** endpoints con RF u origen; FE-CONTRACT reconciliados; sin lógica inventada | ✅ 128 operaciones trazadas; 100 % de las llamadas de `http.ts` cubiertas; supuestos marcados como SUPUESTO o PROPUESTA |
| **Dominio:** reglas críticas en backend; class-validator no sustituye RN; lifecycle protegido; borrado semántico | ✅ reglas en funciones puras + servicios; máquinas de estado por entidad; sin DELETE de negocio |
| **Seguridad:** authn ≠ authz; permisos, alcances y políticas; aislamiento centralizado; Admin Tenant sin cross-tenant; Delegado no altera al Nativo; secretos no expuestos | ✅ verificado en integración (RLS como segunda capa pendiente, C.2-1) |
| **Datos:** modelo desde DOC-A; transacciones críticas; migraciones seguras; concurrencia e idempotencia donde aplican | ✅ §O/P/Q/R/U |
| **SaaS:** tenants, suscripciones, bloqueo y reactivación, auditoría, alertas, consola soportada | ⚠ planes, precios y facturación PENDIENTES (FE-CONTRACT-016); respaldos PENDIENTES (OPS) |
| **Integración:** FE-CONTRACT reconciliados; API documentada; errores consistentes; filtros y paginación compatibles | ✅ OpenAPI + §E/F; 9 propuestas de ajuste al FE (§F.3) |
| **QA:** auth, permisos, aislamiento, workflows, transacciones, errores y conflictos probados; NFR de rendimiento no inventados | ✅ 53 + 30 + 48; rendimiento pendiente de GAP-005 |
| **Orden de cadena:** no se anticipó DevOps; no se redefinió DOC-A; ausencia de DOC-B no bloquea | ✅ |

### Riesgos y deuda registrados

| Riesgo | Severidad | Tratamiento |
|---|---|---|
| RLS no activado (solo aislamiento en la aplicación) | Media | Activación por etapas (C.2-1); el aislamiento de la aplicación está probado |
| Listas de maestros paginadas en memoria (vehículos, conductores, documentos, rutas, usuarios, servicios): la elegibilidad es un valor derivado | Media | Viable para flotas medianas; revisar con la volumetría de GAP-005 (vista materializada o columna calculada) |
| Rate limit, métricas y WebSocket en memoria por réplica | Media | Decisión de DOC-I-OPS antes de escalar horizontalmente |
| `npm audit` (dependencias de producción): 4 altas en la cadena de la CLI de Prisma (`deepmerge-ts` al cargar la configuración; `mysql2`, driver no usado en PostgreSQL). La única «corrección» propuesta es bajar a Prisma 6 | Media | No se degrada; seguir las versiones de Prisma 7.x. `fastify` se fijó en 5.12.5 (override) para cerrar sus 2 moderadas |
| Contraseña temporal devuelta en la respuesta | Media | Aceptable sobre TLS y solo una vez; DOC-F-INT puede reemplazarla por invitación por correo |
| Adaptador de archivos local | Alta en producción | Obligatorio reemplazarlo antes del Go-Live (DOC-I-OPS) |

### PROPUESTAS DE CAMBIO A DOC-A (surgidas en el backend)

1. **Registrado → Disponible (vehículo):** criterio adoptado = al menos un documento crítico vigente y ninguna causa de «No habilitado» (el catálogo de documentos obligatorios es GAP-010).
2. **«En riesgo» (condición de viaje):** alerta Alta/Crítica abierta o emergencia declarada.
3. **EXC-009:** cancelar un viaje cancela sus reservas «Reservadas» y devuelve la carga «Asignada» a «Registrada»; con pasajeros a bordo, la cancelación se rechaza hasta registrar su bajada.
4. **Checklist del conductor:** 5 ítems fijos (3 críticos) hasta que el negocio los configure.
5. **Umbrales GAP-009 por defecto:** frescura 90 s, sin señal 10 min, por vencer 30 días, tolerancia de velocidad 10 %, retraso 15 min, corredor 1,5 km, gracia 5 días. Configurables; confirmar con Centro de control y Seguridad.
6. **Visibilidad del Cliente comercial (ROL-013):** el modelo soporta `Trip.customerOrgId`, pero ningún flujo de DOC-A define cómo se asigna (GAP-006). Hoy un cliente no ve viajes.
7. **Catálogos iniciales** por negocio nuevo (5 tipos de carga y 5 de servicio de PC-A8/PC-A11), editables.

### PENDIENTE DE PLANIFICACIÓN (sin DOC-B)
Prioridad de: RLS, adaptadores de almacenamiento, notificación y GPS, dominio comercial (FE-CONTRACT-016), respaldos, versión mínima de cliente, pruebas de carga.

## Dictamen

**⚠ DOC-E-BE APTO CON CONTRATOS/ADRs/SUPUESTOS PENDIENTES para DOC-F-INT.**

El backend implementa y verifica contra PostgreSQL real todos los FE-CONTRACT del MVP y de la Fase 2 del frontend, con la seguridad (autenticación, autorización en tres capas, aislamiento centralizado, SoD), la integridad (transacciones, concurrencia, idempotencia, auditoría append-only) y la trazabilidad exigidas. Antes del Go-Live deben cerrarse: adaptador de almacenamiento de producción, canales de notificación, adaptador GPS, estrategia de respaldo y restauración, decisión sobre RLS, dominio comercial persistente (si el negocio lo requiere), GAP-003/005/008/009/010 de DOC-A y los controles de DOC-G-SEC (MFA, política de contraseñas, CSP y gestión de secretos).
