import type { ClientSession, Types } from 'mongoose';
import { AuditLog } from '../models/AuditLog.ts';

export interface AuditParams {
  actorId: Types.ObjectId | string;
  actorRole: string;
  actorName: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  reason?: string;
  ipAddress?: string;
  session?: ClientSession | null;
}

export async function recordAuditLog(params: AuditParams): Promise<void> {
  const doc = new AuditLog({
    actorId: params.actorId,
    actorRole: params.actorRole,
    actorName: params.actorName,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    beforeState: params.beforeState,
    afterState: params.afterState,
    reason: params.reason,
    ipAddress: params.ipAddress,
  });

  if (params.session) {
    await doc.save({ session: params.session });
  } else {
    await doc.save();
  }
}
