-- Referencias entre filas del MISMO tenant (DOC-E-BE §I · NFR-001).
--
-- Una clave foránea simple garantiza que el padre EXISTA, no que sea del mismo negocio: un id de otro tenant sería una referencia
-- válida. Prisma no modela claves foráneas compuestas (id, tenantId) cuando la columna es opcional y "tenantId" obligatoria, así que
-- la garantía vive en PostgreSQL con un trigger genérico. Se ejecuta con el rol de quien escribe: para transportes_app la RLS solo
-- deja ver al padre de su tenant, por lo que el chequeo se cumple por partida doble.
-- Cubre TODA clave foránea simple entre tablas con "tenantId" (salvo tenant y la sesión de soporte, cuyo solicitante es de plataforma).
-- Una FK nueva sin trigger rompe la prueba de integración «toda referencia entre tablas con tenantId tiene su guarda».

CREATE OR REPLACE FUNCTION enforce_same_tenant_reference() RETURNS trigger AS $$
DECLARE
  col text := TG_ARGV[0];
  parent text := TG_ARGV[1];
  ref uuid := (to_jsonb(NEW) ->> col)::uuid;
  ok boolean;
BEGIN
  IF ref IS NULL THEN
    RETURN NEW;
  END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE id = $1 AND "tenantId" IS NOT DISTINCT FROM $2)', parent) INTO ok USING ref, NEW."tenantId";
  IF NOT ok THEN
    RAISE EXCEPTION 'Referencia entre negocios no permitida: %.% apunta a otro tenant (o no existe) en %', TG_TABLE_NAME, col, parent
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT con.conrelid::regclass::text AS child, con.confrelid::regclass::text AS parent, a.attname AS col
    FROM pg_constraint con
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
    WHERE con.contype = 'f' AND array_length(con.conkey, 1) = 1 AND con.connamespace = current_schema()::regnamespace
      AND con.confrelid <> 'tenant'::regclass
      AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = con.conrelid AND x.attname = 'tenantId' AND NOT x.attisdropped)
      AND EXISTS (SELECT 1 FROM pg_attribute y WHERE y.attrelid = con.confrelid AND y.attname = 'tenantId' AND NOT y.attisdropped)
      AND NOT (con.conrelid = 'support_session'::regclass AND a.attname = 'requestedById')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', 'same_tenant_' || r.col, r.child);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF %I, "tenantId" ON %s FOR EACH ROW EXECUTE FUNCTION enforce_same_tenant_reference(%L, %L)',
      'same_tenant_' || r.col, r.col, r.child, r.col, r.parent
    );
  END LOOP;
END $$;

-- El tenant de una fila es INMUTABLE: si pudiera cambiarse, las filas hijas quedarían apuntando a un padre de otro negocio
-- y la guarda anterior (que solo mira al escribir el hijo) no lo vería. Mover datos entre negocios no es una operación soportada.
CREATE OR REPLACE FUNCTION prevent_tenant_change() RETURNS trigger AS $$
BEGIN
  IF OLD."tenantId" IS DISTINCT FROM NEW."tenantId" THEN
    RAISE EXCEPTION 'El tenant de una fila es inmutable (%.tenantId)', TG_TABLE_NAME USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

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
    EXECUTE format('DROP TRIGGER IF EXISTS tenant_immutable ON %I', t);
    EXECUTE format('CREATE TRIGGER tenant_immutable BEFORE UPDATE OF "tenantId" ON %I FOR EACH ROW EXECUTE FUNCTION prevent_tenant_change()', t);
  END LOOP;
END $$;
