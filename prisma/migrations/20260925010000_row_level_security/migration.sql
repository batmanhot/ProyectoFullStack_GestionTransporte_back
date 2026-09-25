-- Aislamiento por tenant en PostgreSQL (defensa en profundidad, DOC-E-BE §I · ADR-005 · NFR-001).
--
-- Toda tabla con columna "tenantId" queda con RLS ACTIVA y FORZADA: el rol de la aplicación (transportes_app, sin BYPASSRLS)
-- solo ve y escribe filas cuyo "tenantId" coincide con `app.tenant_id`, que la aplicación fija con SET LOCAL en cada
-- transacción (src/database). Sin tenant fijado no hay coincidencia: cero filas (fail-closed). Las filas de plataforma
-- ("tenantId" NULL) son invisibles para el rol de la aplicación. El rol transportes_platform (BYPASSRLS) es el único que las ve.
-- Las tablas nuevas con "tenantId" deben quedar cubiertas: lo verifica la prueba de integración «RLS activa en toda tabla con tenantId».

DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.table_name
    FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = current_schema() AND c.column_name = 'tenantId'
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING ("tenantId"::text = current_setting(''app.tenant_id'', true)) WITH CHECK ("tenantId"::text = current_setting(''app.tenant_id'', true))',
      t
    );
  END LOOP;
END $$;

-- El propio negocio: un tenant solo ve su fila.
ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "tenant";
CREATE POLICY tenant_isolation ON "tenant" USING (id::text = current_setting('app.tenant_id', true)) WITH CHECK (id::text = current_setting('app.tenant_id', true));

-- Privilegios de los roles de ejecución (se crean con prisma/sql/roles.sql ANTES de migrar). Si no existen, se omiten.
DO $$
DECLARE
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['transportes_app', 'transportes_platform'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', current_schema(), r);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', current_schema(), r);
      EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', current_schema(), r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', current_schema(), r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I', current_schema(), r);
    END IF;
  END LOOP;
END $$;

-- La plataforma GOBIERNA, NO OPERA (DOC-E-BE §I · EXC-032 · SOD-003): con BYPASSRLS puede LEER datos operativos (contadores, salud,
-- diagnóstico de soporte con sesión SOD-003), pero no escribirlos. Solo transportes_app, confinado por RLS a un tenant, escribe
-- datos de negocio. Conserva escritura sobre lo que gobierna: usuarios, sesiones, auditoría, suscripciones, soporte, respaldos, etc.
DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'transportes_platform') THEN
    FOREACH t IN ARRAY ARRAY[
      'alert', 'booking_event', 'cargo_shipment', 'catalog_item', 'client_profile', 'compliance_document', 'dispatch_message', 'driver',
      'gate_evaluation', 'incident', 'incident_action', 'maintenance_order', 'org_unit', 'passenger_booking', 'passenger_profile', 'route',
      'shipment_event', 'stored_file', 'telemetry_event', 'transport_service', 'trip', 'trip_assignment', 'trip_event', 'vehicle',
      'vehicle_last_position'
    ] LOOP
      EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I FROM transportes_platform', t);
    END LOOP;
  END IF;
END $$;
