import mongoose, { Schema } from 'mongoose';
const auditLogSchema = new Schema({
    actorId: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    },
    actorRole: {
        type: String,
        required: true,
    },
    actorName: {
        type: String,
        required: true,
    },
    action: {
        type: String,
        required: true,
        index: true,
    },
    entityType: {
        type: String,
        required: true,
        index: true,
    },
    entityId: {
        type: String,
        required: true,
        index: true,
    },
    beforeState: {
        type: Schema.Types.Mixed,
    },
    afterState: {
        type: Schema.Types.Mixed,
    },
    reason: {
        type: String,
    },
    ipAddress: {
        type: String,
    },
}, { timestamps: { createdAt: true, updatedAt: false } });
auditLogSchema.index({ createdAt: -1 });
export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
