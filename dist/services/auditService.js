import { AuditLog } from '../models/AuditLog.js';
export async function recordAuditLog(params) {
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
    }
    else {
        await doc.save();
    }
}
