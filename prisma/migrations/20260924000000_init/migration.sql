-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TenantLifecycle" AS ENUM ('Borrador', 'Configurado', 'Activo', 'Suspendido', 'Reactivado', 'Cerrado');

-- CreateEnum
CREATE TYPE "CommercialPlan" AS ENUM ('Starter', 'Business', 'Enterprise');

-- CreateEnum
CREATE TYPE "DeploymentMode" AS ENUM ('SaaS compartido', 'Nube privada gestionada', 'On-premise', 'Híbrido');

-- CreateEnum
CREATE TYPE "SupportSessionStatus" AS ENUM ('Activa', 'Revocada', 'Expirada');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('Activo', 'Inactivo', 'Bloqueado');

-- CreateEnum
CREATE TYPE "OrgUnitType" AS ENUM ('Organización', 'Sede', 'Base', 'Unidad', 'Flota');

-- CreateEnum
CREATE TYPE "VehicleLifecycle" AS ENUM ('Registrado', 'Disponible', 'Asignado', 'En operación');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('Vehículo', 'Conductor');

-- CreateEnum
CREATE TYPE "MaintenanceKind" AS ENUM ('Preventivo', 'Correctivo', 'Inspección');

-- CreateEnum
CREATE TYPE "MaintenanceStatus" AS ENUM ('Pendiente', 'Programada', 'En ejecución', 'Completada', 'Cerrada', 'Cancelada');

-- CreateEnum
CREATE TYPE "InspectionResult" AS ENUM ('Aprobada', 'Rechazada');

-- CreateEnum
CREATE TYPE "RouteStatus" AS ENUM ('Borrador', 'Autorizada', 'Obsoleta');

-- CreateEnum
CREATE TYPE "ServiceStatus" AS ENUM ('Borrador', 'Vigente', 'Suspendido', 'Finalizado');

-- CreateEnum
CREATE TYPE "ClientDocumentType" AS ENUM ('RUC', 'DNI');

-- CreateEnum
CREATE TYPE "TripLifecycle" AS ENUM ('Borrador', 'Planificado', 'Asignado', 'Listo para salida', 'En ruta', 'En destino', 'Cerrado', 'Cancelado', 'Interrumpido', 'Reprogramado');

-- CreateEnum
CREATE TYPE "TripPriority" AS ENUM ('Normal', 'Alta', 'Urgente');

-- CreateEnum
CREATE TYPE "TripEventKind" AS ENUM ('Plan', 'Asignación', 'Gate', 'Despacho', 'Ejecución', 'Alerta', 'Incidencia', 'Cambio', 'Cierre');

-- CreateEnum
CREATE TYPE "MessageFrom" AS ENUM ('Control', 'Conductor');

-- CreateEnum
CREATE TYPE "AlertKind" AS ENUM ('Exceso de velocidad', 'Desvío de ruta', 'Parada no programada', 'Sin señal', 'Geocerca', 'Retraso', 'Vencimiento');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('Informativa', 'Baja', 'Media', 'Alta', 'Crítica');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('Nueva', 'Reconocida', 'En gestión', 'Resuelta', 'Cerrada');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('Nueva', 'Clasificada', 'En atención', 'Contenida', 'Resuelta', 'Cerrada');

-- CreateEnum
CREATE TYPE "IncidentCategory" AS ENUM ('Avería', 'Accidente', 'Retraso', 'Bloqueo', 'Mecánica', 'Seguridad', 'Carga', 'Pasajero');

-- CreateEnum
CREATE TYPE "CatalogKind" AS ENUM ('cargoType', 'serviceType');

-- CreateEnum
CREATE TYPE "CargoStatus" AS ENUM ('Registrada', 'Asignada', 'En tránsito', 'Entregada', 'Con excepción', 'Cancelada');

-- CreateEnum
CREATE TYPE "PassengerDocumentType" AS ENUM ('DNI', 'CE', 'Pasaporte');

-- CreateEnum
CREATE TYPE "PassengerStatus" AS ENUM ('Reservada', 'Abordó', 'Llegó a destino', 'No se presentó', 'Cancelada');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('Pendiente', 'Disponible');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('Entregada', 'Pendiente', 'Fallida');

-- CreateEnum
CREATE TYPE "AuditKind" AS ENUM ('Negocio', 'Seguridad');

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lifecycle" "TenantLifecycle" NOT NULL DEFAULT 'Borrador',
    "timezone" TEXT NOT NULL,
    "adminContact" TEXT NOT NULL,
    "lastChangeReason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_subscription" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "plan" "CommercialPlan" NOT NULL,
    "billingCycle" TEXT NOT NULL DEFAULT 'Mensual',
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "current" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "tenant_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_deployment" (
    "tenantId" UUID NOT NULL,
    "mode" "DeploymentMode" NOT NULL DEFAULT 'SaaS compartido',
    "version" TEXT NOT NULL,
    "capacityContract" TEXT NOT NULL,
    "technicalContact" TEXT NOT NULL,
    "supportChannel" TEXT NOT NULL,
    "monitoringAuthorized" BOOLEAN NOT NULL DEFAULT true,
    "licenseStatus" TEXT NOT NULL DEFAULT 'Vigente',
    "lastUpdatedAt" TIMESTAMPTZ(3),
    "lastBackupVerifiedAt" TIMESTAMPTZ(3),

    CONSTRAINT "tenant_deployment_pkey" PRIMARY KEY ("tenantId")
);

-- CreateTable
CREATE TABLE "platform_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "quickAccessCardsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "graceDays" INTEGER NOT NULL DEFAULT 5,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_override" (
    "roleId" TEXT NOT NULL,
    "permissions" TEXT[],
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" TEXT NOT NULL,

    CONSTRAINT "role_override_pkey" PRIMARY KEY ("roleId")
);

-- CreateTable
CREATE TABLE "platform_alert_state" (
    "signalId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "changedAt" TIMESTAMPTZ(3) NOT NULL,
    "changedBy" TEXT NOT NULL,

    CONSTRAINT "platform_alert_state_pkey" PRIMARY KEY ("signalId")
);

-- CreateTable
CREATE TABLE "support_session" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "tenantName" TEXT NOT NULL,
    "caseRef" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedById" UUID NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "SupportSessionStatus" NOT NULL DEFAULT 'Activa',
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "support_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_interaction" (
    "id" UUID NOT NULL,
    "sessionId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "sessionStatus" "SupportSessionStatus" NOT NULL,

    CONSTRAINT "support_interaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_record" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "tenantName" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "sizeApproxKb" INTEGER NOT NULL,
    "storageRef" TEXT,
    "lastRestoredAt" TIMESTAMPTZ(3),

    CONSTRAINT "backup_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "tenantId" UUID,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailKey" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'Activo',
    "isNative" BOOLEAN NOT NULL DEFAULT false,
    "document" TEXT,
    "lastLoginAt" TIMESTAMPTZ(3),
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "userId" UUID NOT NULL,
    "tenantId" UUID,
    "roleId" TEXT NOT NULL,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("userId","roleId")
);

-- CreateTable
CREATE TABLE "user_scope" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tenantId" UUID,
    "type" TEXT NOT NULL,
    "refId" TEXT,
    "label" TEXT NOT NULL,

    CONSTRAINT "user_scope_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tenantId" UUID,
    "familyId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "rotatedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "revokeReason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "org_unit" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "type" "OrgUnitType" NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "city" TEXT,
    "address" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "org_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenant_counter" (
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "tenant_counter_pkey" PRIMARY KEY ("tenantId","name")
);

-- CreateTable
CREATE TABLE "vehicle" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "plate" TEXT NOT NULL,
    "vehicleClass" TEXT NOT NULL,
    "fleetId" UUID NOT NULL,
    "baseId" UUID NOT NULL,
    "capacityPassengers" INTEGER NOT NULL,
    "capacityKg" INTEGER NOT NULL,
    "fuel" TEXT NOT NULL,
    "odometerKm" INTEGER NOT NULL,
    "gpsDeviceId" TEXT,
    "lifecycle" "VehicleLifecycle" NOT NULL DEFAULT 'Registrado',
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "blockReason" TEXT,
    "blockedById" UUID,
    "outOfService" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "licenseNo" TEXT NOT NULL,
    "licenseCategory" TEXT NOT NULL,
    "licenseExpiry" TIMESTAMPTZ(3) NOT NULL,
    "baseId" UUID NOT NULL,
    "restrictions" TEXT NOT NULL DEFAULT '',
    "trainingPending" BOOLEAN NOT NULL DEFAULT false,
    "aptitudePending" BOOLEAN NOT NULL DEFAULT false,
    "inactive" BOOLEAN NOT NULL DEFAULT false,
    "userId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "compliance_document" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "resourceType" "ResourceType" NOT NULL,
    "resourceId" UUID NOT NULL,
    "resourceLabel" TEXT NOT NULL,
    "docType" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "critical" BOOLEAN NOT NULL,
    "replaced" BOOLEAN NOT NULL DEFAULT false,
    "replacedAt" TIMESTAMPTZ(3),
    "fileId" UUID,
    "fileName" TEXT,
    "fileSize" INTEGER,
    "fileType" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "compliance_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_order" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "vehicleId" UUID NOT NULL,
    "vehiclePlate" TEXT NOT NULL,
    "kind" "MaintenanceKind" NOT NULL,
    "status" "MaintenanceStatus" NOT NULL DEFAULT 'Pendiente',
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL,
    "description" TEXT NOT NULL,
    "critical" BOOLEAN NOT NULL,
    "inspectionResult" "InspectionResult",
    "odometerKm" INTEGER,
    "cancelReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "maintenance_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "points" JSONB NOT NULL,
    "geofences" JSONB NOT NULL,
    "speedLimitKmh" INTEGER NOT NULL,
    "distanceKm" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "RouteStatus" NOT NULL,
    "baseId" UUID NOT NULL,
    "authorizedAlternatives" TEXT[],
    "retiredReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transport_service" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "documentType" "ClientDocumentType",
    "document" TEXT,
    "customer" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "routeIds" UUID[],
    "startsAt" TIMESTAMPTZ(3) NOT NULL,
    "endsAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "ServiceStatus" NOT NULL DEFAULT 'Borrador',
    "notes" TEXT NOT NULL DEFAULT '',
    "lastChangeReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "transport_service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "routeId" UUID NOT NULL,
    "routeName" TEXT NOT NULL,
    "routeVersion" INTEGER NOT NULL,
    "baseId" UUID NOT NULL,
    "baseName" TEXT NOT NULL,
    "plannedDeparture" TIMESTAMPTZ(3) NOT NULL,
    "plannedEta" TIMESTAMPTZ(3) NOT NULL,
    "etaUpdated" TIMESTAMPTZ(3),
    "vehicleId" UUID,
    "vehiclePlate" TEXT,
    "driverId" UUID,
    "driverName" TEXT,
    "priority" "TripPriority" NOT NULL,
    "instructions" TEXT NOT NULL DEFAULT '',
    "lifecycle" "TripLifecycle" NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "serviceId" UUID,
    "serviceCode" TEXT,
    "serviceName" TEXT,
    "customerOrgId" UUID,
    "dispatchAuthorized" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMPTZ(3),
    "arrivedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "closedOnTime" BOOLEAN,
    "replacedByTripId" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_event" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "kind" "TripEventKind" NOT NULL,
    "summary" TEXT NOT NULL,
    "reason" TEXT,

    CONSTRAINT "trip_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trip_assignment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vehiclePlate" TEXT,
    "driverName" TEXT,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "evidence" TEXT,

    CONSTRAINT "trip_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gate_evaluation" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "evaluatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "overall" TEXT NOT NULL,
    "failed" BOOLEAN NOT NULL,
    "requirements" JSONB NOT NULL,
    "action" TEXT NOT NULL,

    CONSTRAINT "gate_evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispatch_message" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "tripCode" TEXT NOT NULL,
    "vehiclePlate" TEXT,
    "from" "MessageFrom" NOT NULL,
    "authorName" TEXT NOT NULL,
    "authorId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispatch_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telemetry_event" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "vehicleId" UUID NOT NULL,
    "deviceId" TEXT NOT NULL,
    "sourceTime" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "speedKmh" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "ignition" BOOLEAN,
    "odometerKm" INTEGER,
    "outOfOrder" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "telemetry_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_last_position" (
    "vehicleId" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "tripId" UUID,
    "lat" DOUBLE PRECISION NOT NULL,
    "lon" DOUBLE PRECISION NOT NULL,
    "speedKmh" DOUBLE PRECISION,
    "heading" DOUBLE PRECISION,
    "ignition" BOOLEAN,
    "sourceTime" TIMESTAMPTZ(3) NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vehicle_last_position_pkey" PRIMARY KEY ("vehicleId")
);

-- CreateTable
CREATE TABLE "integration_credential" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "AlertKind" NOT NULL,
    "severity" "Severity" NOT NULL,
    "status" "AlertStatus" NOT NULL DEFAULT 'Nueva',
    "tripId" UUID,
    "tripCode" TEXT,
    "vehicleId" UUID,
    "vehiclePlate" TEXT,
    "detail" TEXT NOT NULL,
    "assignee" TEXT,
    "incidentId" UUID,
    "evidence" TEXT,
    "evidenceFileIds" UUID[],
    "requiresReview" BOOLEAN NOT NULL DEFAULT false,
    "documentId" UUID,
    "subject" TEXT,
    "dueAt" TIMESTAMPTZ(3),
    "phase" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "category" "IncidentCategory",
    "severity" "Severity" NOT NULL,
    "status" "IncidentStatus" NOT NULL,
    "emergency" BOOLEAN NOT NULL DEFAULT false,
    "originAlertId" UUID,
    "tripId" UUID,
    "tripCode" TEXT,
    "vehicleId" UUID,
    "vehiclePlate" TEXT,
    "description" TEXT NOT NULL,
    "continuityPlan" TEXT,
    "resolution" TEXT,
    "evidenceNames" TEXT[],
    "evidenceFileIds" UUID[],
    "reportedBy" TEXT NOT NULL,
    "reportedById" UUID NOT NULL,
    "requiresReview" BOOLEAN NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_action" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "incident_action_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "catalog_item" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" "CatalogKind" NOT NULL,
    "label" TEXT NOT NULL,
    "labelKey" TEXT NOT NULL,
    "hint" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "catalog_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_profile" (
    "tenantId" UUID NOT NULL,
    "documentType" "ClientDocumentType" NOT NULL,
    "document" TEXT NOT NULL,
    "customer" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "client_profile_pkey" PRIMARY KEY ("tenantId","documentType","document")
);

-- CreateTable
CREATE TABLE "cargo_shipment" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "documentType" "ClientDocumentType" NOT NULL,
    "document" TEXT NOT NULL,
    "customer" TEXT NOT NULL,
    "cargoType" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "packages" INTEGER NOT NULL,
    "weightKg" DOUBLE PRECISION NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "promisedAt" TIMESTAMPTZ(3) NOT NULL,
    "status" "CargoStatus" NOT NULL DEFAULT 'Registrada',
    "tripId" UUID,
    "tripCode" TEXT,
    "vehiclePlate" TEXT,
    "exception" TEXT,
    "hadException" BOOLEAN NOT NULL DEFAULT false,
    "receivedBy" TEXT,
    "deliveredAt" TIMESTAMPTZ(3),
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "cargo_shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_event" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "shipmentId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "shipment_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "passenger_profile" (
    "tenantId" UUID NOT NULL,
    "documentType" "PassengerDocumentType" NOT NULL,
    "document" TEXT NOT NULL,
    "lastNamePaternal" TEXT NOT NULL,
    "lastNameMaternal" TEXT NOT NULL DEFAULT '',
    "firstNames" TEXT NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "passenger_profile_pkey" PRIMARY KEY ("tenantId","documentType","document")
);

-- CreateTable
CREATE TABLE "passenger_booking" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "documentType" "PassengerDocumentType" NOT NULL,
    "document" TEXT NOT NULL,
    "lastNamePaternal" TEXT NOT NULL,
    "lastNameMaternal" TEXT NOT NULL DEFAULT '',
    "firstNames" TEXT NOT NULL,
    "phone" TEXT,
    "reducedMobility" BOOLEAN NOT NULL DEFAULT false,
    "tripId" UUID NOT NULL,
    "tripCode" TEXT NOT NULL,
    "routeName" TEXT NOT NULL,
    "plannedDeparture" TIMESTAMPTZ(3) NOT NULL,
    "vehiclePlate" TEXT NOT NULL,
    "boardStop" TEXT NOT NULL,
    "alightStop" TEXT NOT NULL,
    "seat" INTEGER NOT NULL,
    "status" "PassengerStatus" NOT NULL DEFAULT 'Reservada',
    "cancelReason" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "passenger_booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_event" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "booking_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_file" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "status" "FileStatus" NOT NULL DEFAULT 'Pendiente',
    "uploadedBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "stored_file_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMPTZ(3),

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_delivery" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_event" (
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "AuditKind" NOT NULL,
    "tenantId" UUID,
    "actorUserId" UUID,
    "actor" TEXT NOT NULL,
    "actorRoles" TEXT[],
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "result" TEXT NOT NULL DEFAULT 'OK',
    "reason" TEXT,
    "before" TEXT,
    "after" TEXT,
    "correlationId" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "audit_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "id" UUID NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "response" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_run" (
    "id" UUID NOT NULL,
    "job" TEXT NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),
    "status" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "job_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_name_key" ON "tenant"("name");

-- CreateIndex
CREATE INDEX "tenant_subscription_tenantId_current_idx" ON "tenant_subscription"("tenantId", "current");

-- CreateIndex
CREATE INDEX "support_session_status_expiresAt_idx" ON "support_session"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "support_interaction_at_idx" ON "support_interaction"("at");

-- CreateIndex
CREATE INDEX "backup_record_tenantId_createdAt_idx" ON "backup_record"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "app_user_tenantId_status_idx" ON "app_user"("tenantId", "status");

-- CreateIndex
CREATE INDEX "user_role_tenantId_roleId_idx" ON "user_role"("tenantId", "roleId");

-- CreateIndex
CREATE INDEX "user_scope_userId_idx" ON "user_scope"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "auth_session_tokenHash_key" ON "auth_session"("tokenHash");

-- CreateIndex
CREATE INDEX "auth_session_userId_revokedAt_idx" ON "auth_session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "auth_session_familyId_idx" ON "auth_session"("familyId");

-- CreateIndex
CREATE INDEX "org_unit_tenantId_type_idx" ON "org_unit"("tenantId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "org_unit_tenantId_type_name_key" ON "org_unit"("tenantId", "type", "name");

-- CreateIndex
CREATE INDEX "vehicle_tenantId_baseId_idx" ON "vehicle"("tenantId", "baseId");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_tenantId_plate_key" ON "vehicle"("tenantId", "plate");

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_tenantId_gpsDeviceId_key" ON "vehicle"("tenantId", "gpsDeviceId");

-- CreateIndex
CREATE UNIQUE INDEX "driver_userId_key" ON "driver"("userId");

-- CreateIndex
CREATE INDEX "driver_tenantId_baseId_idx" ON "driver"("tenantId", "baseId");

-- CreateIndex
CREATE UNIQUE INDEX "driver_tenantId_licenseNo_key" ON "driver"("tenantId", "licenseNo");

-- CreateIndex
CREATE INDEX "compliance_document_tenantId_resourceId_replaced_idx" ON "compliance_document"("tenantId", "resourceId", "replaced");

-- CreateIndex
CREATE INDEX "compliance_document_tenantId_expiresAt_idx" ON "compliance_document"("tenantId", "expiresAt");

-- CreateIndex
CREATE INDEX "maintenance_order_tenantId_vehicleId_status_idx" ON "maintenance_order"("tenantId", "vehicleId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "maintenance_order_tenantId_code_key" ON "maintenance_order"("tenantId", "code");

-- CreateIndex
CREATE INDEX "route_tenantId_name_status_idx" ON "route"("tenantId", "name", "status");

-- CreateIndex
CREATE INDEX "route_tenantId_baseId_idx" ON "route"("tenantId", "baseId");

-- CreateIndex
CREATE UNIQUE INDEX "transport_service_tenantId_code_key" ON "transport_service"("tenantId", "code");

-- CreateIndex
CREATE INDEX "trip_tenantId_lifecycle_idx" ON "trip"("tenantId", "lifecycle");

-- CreateIndex
CREATE INDEX "trip_tenantId_vehicleId_lifecycle_idx" ON "trip"("tenantId", "vehicleId", "lifecycle");

-- CreateIndex
CREATE INDEX "trip_tenantId_driverId_lifecycle_idx" ON "trip"("tenantId", "driverId", "lifecycle");

-- CreateIndex
CREATE INDEX "trip_tenantId_baseId_plannedDeparture_idx" ON "trip"("tenantId", "baseId", "plannedDeparture");

-- CreateIndex
CREATE UNIQUE INDEX "trip_tenantId_code_key" ON "trip"("tenantId", "code");

-- CreateIndex
CREATE INDEX "trip_event_tripId_at_idx" ON "trip_event"("tripId", "at");

-- CreateIndex
CREATE INDEX "trip_assignment_tripId_at_idx" ON "trip_assignment"("tripId", "at");

-- CreateIndex
CREATE INDEX "gate_evaluation_tenantId_evaluatedAt_idx" ON "gate_evaluation"("tenantId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "dispatch_message_tenantId_tripId_sentAt_idx" ON "dispatch_message"("tenantId", "tripId", "sentAt");

-- CreateIndex
CREATE INDEX "telemetry_event_tenantId_receivedAt_idx" ON "telemetry_event"("tenantId", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_event_vehicleId_sourceTime_key" ON "telemetry_event"("vehicleId", "sourceTime");

-- CreateIndex
CREATE INDEX "vehicle_last_position_tenantId_idx" ON "vehicle_last_position"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "integration_credential_keyHash_key" ON "integration_credential"("keyHash");

-- CreateIndex
CREATE INDEX "integration_credential_tenantId_kind_idx" ON "integration_credential"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "alert_tenantId_status_idx" ON "alert"("tenantId", "status");

-- CreateIndex
CREATE INDEX "alert_tenantId_tripId_idx" ON "alert"("tenantId", "tripId");

-- CreateIndex
CREATE INDEX "alert_tenantId_vehicleId_kind_status_idx" ON "alert"("tenantId", "vehicleId", "kind", "status");

-- CreateIndex
CREATE INDEX "alert_tenantId_documentId_idx" ON "alert"("tenantId", "documentId");

-- CreateIndex
CREATE INDEX "alert_tenantId_dedupeKey_idx" ON "alert"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "incident_tenantId_status_idx" ON "incident"("tenantId", "status");

-- CreateIndex
CREATE INDEX "incident_tenantId_originAlertId_idx" ON "incident"("tenantId", "originAlertId");

-- CreateIndex
CREATE UNIQUE INDEX "incident_tenantId_code_key" ON "incident"("tenantId", "code");

-- CreateIndex
CREATE INDEX "incident_action_incidentId_at_idx" ON "incident_action"("incidentId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_item_tenantId_kind_labelKey_key" ON "catalog_item"("tenantId", "kind", "labelKey");

-- CreateIndex
CREATE INDEX "cargo_shipment_tenantId_tripId_status_idx" ON "cargo_shipment"("tenantId", "tripId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "cargo_shipment_tenantId_code_key" ON "cargo_shipment"("tenantId", "code");

-- CreateIndex
CREATE INDEX "shipment_event_shipmentId_at_idx" ON "shipment_event"("shipmentId", "at");

-- CreateIndex
CREATE INDEX "passenger_booking_tenantId_tripId_status_idx" ON "passenger_booking"("tenantId", "tripId", "status");

-- CreateIndex
CREATE INDEX "passenger_booking_tenantId_documentType_document_idx" ON "passenger_booking"("tenantId", "documentType", "document");

-- CreateIndex
CREATE UNIQUE INDEX "passenger_booking_tenantId_code_key" ON "passenger_booking"("tenantId", "code");

-- CreateIndex
CREATE INDEX "booking_event_bookingId_at_idx" ON "booking_event"("bookingId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "stored_file_storageKey_key" ON "stored_file"("storageKey");

-- CreateIndex
CREATE INDEX "stored_file_tenantId_status_idx" ON "stored_file"("tenantId", "status");

-- CreateIndex
CREATE INDEX "notification_tenantId_createdAt_idx" ON "notification"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_tenantId_dedupeKey_key" ON "notification"("tenantId", "dedupeKey");

-- CreateIndex
CREATE INDEX "notification_delivery_status_nextAttemptAt_idx" ON "notification_delivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "audit_event_tenantId_at_id_idx" ON "audit_event"("tenantId", "at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "audit_event_tenantId_resourceType_resourceId_at_idx" ON "audit_event"("tenantId", "resourceType", "resourceId", "at");

-- CreateIndex
CREATE INDEX "audit_event_action_at_idx" ON "audit_event"("action", "at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_record_scopeKey_key" ON "idempotency_record"("scopeKey");

-- CreateIndex
CREATE INDEX "idempotency_record_expiresAt_idx" ON "idempotency_record"("expiresAt");

-- CreateIndex
CREATE INDEX "job_run_job_startedAt_idx" ON "job_run"("job", "startedAt");

-- AddForeignKey
ALTER TABLE "tenant_subscription" ADD CONSTRAINT "tenant_subscription_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_deployment" ADD CONSTRAINT "tenant_deployment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_interaction" ADD CONSTRAINT "support_interaction_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "support_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "app_user" ADD CONSTRAINT "app_user_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_scope" ADD CONSTRAINT "user_scope_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "org_unit" ADD CONSTRAINT "org_unit_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "org_unit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver" ADD CONSTRAINT "driver_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_event" ADD CONSTRAINT "trip_event_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_assignment" ADD CONSTRAINT "trip_assignment_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_action" ADD CONSTRAINT "incident_action_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_event" ADD CONSTRAINT "shipment_event_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "cargo_shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_event" ADD CONSTRAINT "booking_event_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "passenger_booking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ═══════════════════════════════════════════════════════════════════════════
-- DOC-E-BE §O/§P — Reglas de integridad que Prisma no expresa (escritas a mano).
-- ═══════════════════════════════════════════════════════════════════════════

-- ADR-011 / RF-029: la auditoría es append-only. Ni la aplicación ni un operador pueden editarla o borrarla.
CREATE OR REPLACE FUNCTION audit_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_event es append-only: % no permitido', TG_OP USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_event_no_update BEFORE UPDATE OR DELETE ON "audit_event" FOR EACH ROW EXECUTE FUNCTION audit_event_append_only();
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON "audit_event" FOR EACH STATEMENT EXECUTE FUNCTION audit_event_append_only();

-- PC-A22: el correo es único POR negocio (y entre cuentas de plataforma), no en toda la instalación.
CREATE UNIQUE INDEX "app_user_tenant_email_key" ON "app_user" ("tenantId", "emailKey") WHERE "tenantId" IS NOT NULL;
CREATE UNIQUE INDEX "app_user_platform_email_key" ON "app_user" ("emailKey") WHERE "tenantId" IS NULL;
-- PC-A1: un único SuperAdmin Nativo.
CREATE UNIQUE INDEX "app_user_single_native" ON "app_user" (("isNative")) WHERE "isNative";

-- PC-A1 Fase 4: una sola suscripción vigente por negocio (las anteriores quedan como historial).
CREATE UNIQUE INDEX "tenant_subscription_current_key" ON "tenant_subscription" ("tenantId") WHERE "current";
ALTER TABLE "tenant_subscription" ADD CONSTRAINT "tenant_subscription_range_chk" CHECK ("endsAt" > "startsAt");

-- EXC-025: una sola incidencia abierta por alerta de origen.
CREATE UNIQUE INDEX "incident_open_per_alert_key" ON "incident" ("tenantId", "originAlertId") WHERE "originAlertId" IS NOT NULL AND "status" <> 'Cerrada';
-- Reglas de detección idempotentes: una alerta ABIERTA por condición (p. ej. documento + fase, vehículo + exceso).
CREATE UNIQUE INDEX "alert_open_dedupe_key" ON "alert" ("tenantId", "dedupeKey") WHERE "dedupeKey" IS NOT NULL AND "status" NOT IN ('Resuelta', 'Cerrada');

ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_singleton_chk" CHECK ("id" = 1);
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_grace_chk" CHECK ("graceDays" BETWEEN 0 AND 60);
ALTER TABLE "support_session" ADD CONSTRAINT "support_session_max_8h_chk" CHECK ("expiresAt" > "startedAt" AND "expiresAt" <= "startedAt" + INTERVAL '8 hours');
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_capacity_chk" CHECK ("capacityPassengers" >= 0 AND "capacityKg" >= 0 AND "odometerKm" >= 0);
ALTER TABLE "trip" ADD CONSTRAINT "trip_window_chk" CHECK ("plannedEta" > "plannedDeparture");
ALTER TABLE "compliance_document" ADD CONSTRAINT "document_validity_chk" CHECK ("expiresAt" > "issuedAt");
ALTER TABLE "cargo_shipment" ADD CONSTRAINT "cargo_quantities_chk" CHECK ("packages" >= 1 AND "weightKg" > 0);
ALTER TABLE "passenger_booking" ADD CONSTRAINT "booking_seat_chk" CHECK ("seat" >= 1);
ALTER TABLE "stored_file" ADD CONSTRAINT "stored_file_size_chk" CHECK ("size" > 0 AND "size" <= 5242880);

-- Fila única de ajustes con valores por defecto (graceDays = 5: SUPUESTO, el SuperAdmin lo ajusta en FE-082).
INSERT INTO "platform_settings" ("id", "quickAccessCardsEnabled", "graceDays", "updatedAt") VALUES (1, false, 5, now());

-- Jobs: una sola ejecución EN CURSO por job en toda la instalación (lease seguro con pool de conexiones y varias réplicas).
CREATE UNIQUE INDEX "job_run_single_running" ON "job_run" ("job") WHERE "status" = 'RUNNING';
