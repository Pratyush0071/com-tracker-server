import type { ClientSession, Types } from 'mongoose';
import { Notification } from '../models/Notification.js';

export interface CreateNotificationParams {
  recipientId?: Types.ObjectId | string;
  recipientRole: 'admin' | 'employee';
  type: string;
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  session?: ClientSession | null;
}

export async function createNotification(params: CreateNotificationParams): Promise<void> {
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
  } else {
    await doc.save();
  }
}
