import type {
  AlertKind, AlertStatus, CargoStatus, CatalogKind, CommercialPlan, DeploymentMode, IncidentCategory, IncidentStatus, InspectionResult,
  MaintenanceKind, MaintenanceStatus, OrgUnitType, PassengerDocumentType, PassengerStatus, ResourceType, RouteStatus, ServiceStatus,
  Severity, SupportSessionStatus, TenantLifecycle, TripEventKind, TripLifecycle, TripPriority, UserStatus, VehicleLifecycle,
} from '../generated/prisma/client'

/**
 * Traducción enum de persistencia ↔ etiqueta de negocio (DOC-A). La API habla SIEMPRE con las etiquetas de DOC-A
 * (las mismas que usa DOC-D-FE); la BD guarda las mismas etiquetas vía @map. Separar ambos tipos evita exponer
 * identificadores internos y permite validar entradas contra el vocabulario oficial.
 */
export interface LabelMap<E extends string, L extends string> {
  label(e: E): L
  /** Etiqueta → enum; `undefined` si la etiqueta no pertenece al vocabulario. */
  parse(l: string | null | undefined): E | undefined
  labels: L[]
}

export function labelMap<E extends string, L extends string>(m: Record<E, L>): LabelMap<E, L> {
  const rev = new Map<string, E>((Object.entries(m) as [E, L][]).map(([k, v]) => [v, k]))
  return {
    label: (e) => m[e],
    parse: (l) => (l == null ? undefined : rev.get(l)),
    labels: Object.values(m) as L[],
  }
}

export const TENANT_LIFECYCLE = labelMap<TenantLifecycle, 'Borrador' | 'Configurado' | 'Activo' | 'Suspendido' | 'Reactivado' | 'Cerrado'>({
  BORRADOR: 'Borrador', CONFIGURADO: 'Configurado', ACTIVO: 'Activo', SUSPENDIDO: 'Suspendido', REACTIVADO: 'Reactivado', CERRADO: 'Cerrado',
})
export const PLAN = labelMap<CommercialPlan, 'Starter' | 'Business' | 'Enterprise'>({ STARTER: 'Starter', BUSINESS: 'Business', ENTERPRISE: 'Enterprise' })
export const DEPLOYMENT_MODE = labelMap<DeploymentMode, 'SaaS compartido' | 'Nube privada gestionada' | 'On-premise' | 'Híbrido'>({
  SAAS: 'SaaS compartido', PRIVATE: 'Nube privada gestionada', ON_PREMISE: 'On-premise', HYBRID: 'Híbrido',
})
export const SUPPORT_STATUS = labelMap<SupportSessionStatus, 'Activa' | 'Revocada' | 'Expirada'>({ ACTIVA: 'Activa', REVOCADA: 'Revocada', EXPIRADA: 'Expirada' })
export const USER_STATUS = labelMap<UserStatus, 'Activo' | 'Inactivo' | 'Bloqueado'>({ ACTIVO: 'Activo', INACTIVO: 'Inactivo', BLOQUEADO: 'Bloqueado' })
export const ORG_TYPE = labelMap<OrgUnitType, 'Organización' | 'Sede' | 'Base' | 'Unidad' | 'Flota'>({
  ORGANIZACION: 'Organización', SEDE: 'Sede', BASE: 'Base', UNIDAD: 'Unidad', FLOTA: 'Flota',
})
export const VEHICLE_LIFECYCLE = labelMap<VehicleLifecycle, 'Registrado' | 'Disponible' | 'Asignado' | 'En operación'>({
  REGISTRADO: 'Registrado', DISPONIBLE: 'Disponible', ASIGNADO: 'Asignado', EN_OPERACION: 'En operación',
})
export const RESOURCE_TYPE = labelMap<ResourceType, 'Vehículo' | 'Conductor'>({ VEHICULO: 'Vehículo', CONDUCTOR: 'Conductor' })
export const MAINT_KIND = labelMap<MaintenanceKind, 'Preventivo' | 'Correctivo' | 'Inspección'>({ PREVENTIVO: 'Preventivo', CORRECTIVO: 'Correctivo', INSPECCION: 'Inspección' })
export const MAINT_STATUS = labelMap<MaintenanceStatus, 'Pendiente' | 'Programada' | 'En ejecución' | 'Completada' | 'Cerrada' | 'Cancelada'>({
  PENDIENTE: 'Pendiente', PROGRAMADA: 'Programada', EN_EJECUCION: 'En ejecución', COMPLETADA: 'Completada', CERRADA: 'Cerrada', CANCELADA: 'Cancelada',
})
export const INSPECTION = labelMap<InspectionResult, 'Aprobada' | 'Rechazada'>({ APROBADA: 'Aprobada', RECHAZADA: 'Rechazada' })
export const ROUTE_STATUS = labelMap<RouteStatus, 'Borrador' | 'Autorizada' | 'Obsoleta'>({ BORRADOR: 'Borrador', AUTORIZADA: 'Autorizada', OBSOLETA: 'Obsoleta' })
export const SERVICE_STATUS = labelMap<ServiceStatus, 'Borrador' | 'Vigente' | 'Suspendido' | 'Finalizado'>({
  BORRADOR: 'Borrador', VIGENTE: 'Vigente', SUSPENDIDO: 'Suspendido', FINALIZADO: 'Finalizado',
})
export type TripLifecycleLabel = 'Borrador' | 'Planificado' | 'Asignado' | 'Listo para salida' | 'En ruta' | 'En destino' | 'Cerrado' | 'Cancelado' | 'Interrumpido' | 'Reprogramado'
export const TRIP_LIFECYCLE = labelMap<TripLifecycle, TripLifecycleLabel>({
  BORRADOR: 'Borrador', PLANIFICADO: 'Planificado', ASIGNADO: 'Asignado', LISTO_PARA_SALIDA: 'Listo para salida', EN_RUTA: 'En ruta', EN_DESTINO: 'En destino',
  CERRADO: 'Cerrado', CANCELADO: 'Cancelado', INTERRUMPIDO: 'Interrumpido', REPROGRAMADO: 'Reprogramado',
})
export const PRIORITY = labelMap<TripPriority, 'Normal' | 'Alta' | 'Urgente'>({ NORMAL: 'Normal', ALTA: 'Alta', URGENTE: 'Urgente' })
export const TRIP_EVENT = labelMap<TripEventKind, 'Plan' | 'Asignación' | 'Gate' | 'Despacho' | 'Ejecución' | 'Alerta' | 'Incidencia' | 'Cambio' | 'Cierre'>({
  PLAN: 'Plan', ASIGNACION: 'Asignación', GATE: 'Gate', DESPACHO: 'Despacho', EJECUCION: 'Ejecución', ALERTA: 'Alerta', INCIDENCIA: 'Incidencia', CAMBIO: 'Cambio', CIERRE: 'Cierre',
})
export type AlertKindLabel = 'Exceso de velocidad' | 'Desvío de ruta' | 'Parada no programada' | 'Sin señal' | 'Geocerca' | 'Retraso' | 'Vencimiento'
export const ALERT_KIND = labelMap<AlertKind, AlertKindLabel>({
  EXCESO_VELOCIDAD: 'Exceso de velocidad', DESVIO_RUTA: 'Desvío de ruta', PARADA: 'Parada no programada', SIN_SENAL: 'Sin señal', GEOCERCA: 'Geocerca', RETRASO: 'Retraso', VENCIMIENTO: 'Vencimiento',
})
export type SeverityLabel = 'Informativa' | 'Baja' | 'Media' | 'Alta' | 'Crítica'
export const SEVERITY = labelMap<Severity, SeverityLabel>({ INFORMATIVA: 'Informativa', BAJA: 'Baja', MEDIA: 'Media', ALTA: 'Alta', CRITICA: 'Crítica' })
/** Orden de severidad (mayor = más grave). */
export const SEVERITY_RANK: Record<Severity, number> = { INFORMATIVA: 1, BAJA: 2, MEDIA: 3, ALTA: 4, CRITICA: 5 }
export const ALERT_STATUS = labelMap<AlertStatus, 'Nueva' | 'Reconocida' | 'En gestión' | 'Resuelta' | 'Cerrada'>({
  NUEVA: 'Nueva', RECONOCIDA: 'Reconocida', EN_GESTION: 'En gestión', RESUELTA: 'Resuelta', CERRADA: 'Cerrada',
})
export const INCIDENT_STATUS = labelMap<IncidentStatus, 'Nueva' | 'Clasificada' | 'En atención' | 'Contenida' | 'Resuelta' | 'Cerrada'>({
  NUEVA: 'Nueva', CLASIFICADA: 'Clasificada', EN_ATENCION: 'En atención', CONTENIDA: 'Contenida', RESUELTA: 'Resuelta', CERRADA: 'Cerrada',
})
export const INCIDENT_CATEGORY = labelMap<IncidentCategory, 'Avería' | 'Accidente' | 'Retraso' | 'Bloqueo' | 'Mecánica' | 'Seguridad' | 'Carga' | 'Pasajero'>({
  AVERIA: 'Avería', ACCIDENTE: 'Accidente', RETRASO: 'Retraso', BLOQUEO: 'Bloqueo', MECANICA: 'Mecánica', SEGURIDAD: 'Seguridad', CARGA: 'Carga', PASAJERO: 'Pasajero',
})
export const CATALOG_KIND = labelMap<CatalogKind, 'cargoType' | 'serviceType'>({ CARGO_TYPE: 'cargoType', SERVICE_TYPE: 'serviceType' })
export const CARGO_STATUS = labelMap<CargoStatus, 'Registrada' | 'Asignada' | 'En tránsito' | 'Entregada' | 'Con excepción' | 'Cancelada'>({
  REGISTRADA: 'Registrada', ASIGNADA: 'Asignada', EN_TRANSITO: 'En tránsito', ENTREGADA: 'Entregada', CON_EXCEPCION: 'Con excepción', CANCELADA: 'Cancelada',
})
export const PAX_DOC = labelMap<PassengerDocumentType, 'DNI' | 'CE' | 'Pasaporte'>({ DNI: 'DNI', CE: 'CE', PASAPORTE: 'Pasaporte' })
export const PAX_STATUS = labelMap<PassengerStatus, 'Reservada' | 'Abordó' | 'Llegó a destino' | 'No se presentó' | 'Cancelada'>({
  RESERVADA: 'Reservada', ABORDO: 'Abordó', LLEGO: 'Llegó a destino', NO_SE_PRESENTO: 'No se presentó', CANCELADA: 'Cancelada',
})
