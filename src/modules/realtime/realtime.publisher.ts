import { Injectable } from '@nestjs/common'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { RequestContext } from '../../common/context/request-context'
import type { Permission } from '../access/domain/catalog'

/**
 * Eventos en tiempo real (FE-CONTRACT-013 · ADR-007): SOLO notifican; el cliente reconcilia por REST.
 * Nombres estables y payload explícito (mismo contrato que `core/realtime/types.ts` del FE).
 */
export type RealtimeEvent =
  | { type: 'trip.updated'; tripId: string }
  | { type: 'position.updated'; position: object }
  | { type: 'alert.created'; alert: object }
  | { type: 'notification.created'; notification: object }
  | { type: 'incident.emergency'; incident: object }
  | { type: 'message.created'; message: object }

/**
 * Audiencia del evento: el gateway solo lo entrega a conexiones del MISMO tenant que además cumplan permiso y alcance.
 *  - `anyPerm`: al menos uno de esos permisos.
 *  - `baseId`: el registro pertenece a esa terminal (usuarios con alcance BASE solo ven la suya).
 *  - `driverUserId`: el conductor dueño del viaje también lo recibe aunque no tenga los permisos (OWN_RECORDS).
 */
export interface RealtimeAudience {
  anyPerm?: Permission[]
  baseId?: string | null
  driverUserId?: string | null
}

export interface RealtimeEnvelope {
  tenantId: string
  event: RealtimeEvent
  audience: RealtimeAudience
  correlationId: string
  at: string
}

export const REALTIME_CHANNEL = 'realtime.publish'

@Injectable()
export class RealtimePublisher {
  constructor(private readonly bus: EventEmitter2) {}

  /** Llamar DESPUÉS de confirmar la transacción: un rollback nunca debe notificar algo que no ocurrió. */
  publish(tenantId: string, event: RealtimeEvent, audience: RealtimeAudience = {}): void {
    const envelope: RealtimeEnvelope = { tenantId, event, audience, correlationId: RequestContext.correlationId(), at: new Date().toISOString() }
    this.bus.emit(REALTIME_CHANNEL, envelope)
  }
}
