import mongoose, { Schema } from 'mongoose';
import type { Document, Types } from 'mongoose';

export type IncentiveCategory = 'target_completion' | 'other';

export interface IIncentiveTransaction extends Document {
  employeeId: Types.ObjectId;
  employeeProfileId: Types.ObjectId;
  employeeCode: string;
  employeeName: string;
  cycleId?: Types.ObjectId;
  cycleKey?: string;
  achievementId?: Types.ObjectId;
  category: IncentiveCategory;
  amountPaise: number;
  reason: string;
  authorizedByAdminId: Types.ObjectId;
  authorizedByAdminName: string;
  allowDuplicateOverride: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const incentiveTransactionSchema = new Schema<IIncentiveTransaction>(
  {
    employeeId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    employeeProfileId: {
      type: Schema.Types.ObjectId,
      ref: 'EmployeeProfile',
      required: true,
      index: true,
    },
    employeeCode: {
      type: String,
      required: true,
    },
    employeeName: {
      type: String,
      required: true,
    },
    cycleId: {
      type: Schema.Types.ObjectId,
      ref: 'TargetCycle',
      index: true,
    },
    cycleKey: {
      type: String,
    },
    achievementId: {
      type: Schema.Types.ObjectId,
      ref: 'TargetAchievement',
    },
    category: {
      type: String,
      enum: ['target_completion', 'other'],
      required: true,
      index: true,
    },
    amountPaise: {
      type: Number,
      required: true,
      min: 100,
    },
    reason: {
      type: String,
      required: true,
      trim: true,
      maxlength: 300,
    },
    authorizedByAdminId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    authorizedByAdminName: {
      type: String,
      required: true,
    },
    allowDuplicateOverride: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

incentiveTransactionSchema.index({ employeeId: 1, createdAt: -1 });
incentiveTransactionSchema.index(
  { achievementId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      achievementId: { $type: 'objectId' },
      allowDuplicateOverride: false,
    },
  }
);

export const IncentiveTransaction = mongoose.model<IIncentiveTransaction>(
  'IncentiveTransaction',
  incentiveTransactionSchema
);
