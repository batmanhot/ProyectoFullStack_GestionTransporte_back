-- Roles de ejecución (DOC-E-BE §I). Se ejecuta UNA vez por servidor PostgreSQL, como superusuario o rol con CREATEROLE,
-- ANTES de `prisma migrate deploy`:
--
--   psql -h HOST -U postgres -v app_password='...' -v platform_password='...' -f prisma/sql/roles.sql
--
--  transportes_app      → la API en su operación normal. NOSUPERUSER, NOBYPASSRLS: PostgreSQL le aplica el aislamiento por tenant.
--  transportes_platform → autenticación, consola de plataforma, jobs y endpoints públicos. BYPASSRLS. Nunca para negocio.
--  El dueño de las tablas (quien migra) es un tercer rol, p. ej. el que crea la base; no se usa en tiempo de ejecución.
--
-- Cadenas de conexión: DATABASE_URL=transportes_app · DATABASE_SYSTEM_URL=transportes_platform · MIGRATE_DATABASE_URL=dueño.

SELECT format('CREATE ROLE transportes_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'transportes_app') \gexec
SELECT format('ALTER ROLE transportes_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD %L', :'app_password') \gexec

SELECT format('CREATE ROLE transportes_platform LOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD %L', :'platform_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'transportes_platform') \gexec
SELECT format('ALTER ROLE transportes_platform LOGIN NOSUPERUSER BYPASSRLS PASSWORD %L', :'platform_password') \gexec

-- Permiso de conexión a la base actual (los privilegios sobre tablas los concede la migración row_level_security).
SELECT format('GRANT CONNECT ON DATABASE %I TO transportes_app, transportes_platform', current_database()) \gexec
