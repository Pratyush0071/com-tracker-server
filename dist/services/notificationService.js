import { Notification } from '../models/Notification.js';
export async function createNotification(params) {
    const doc = new Notification({
        recipientId: params.recipientId,
        recipientRole: params.recipientRole,
        type: params.type,
        title: params.title,
        message: params.message,
        metadata: params.metadata || {},
    });
    if (params.session) {
        await doc.save({ session: params.session });
    }
    else {
        await doc.save();
    }
}
