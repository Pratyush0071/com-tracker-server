import mongoose, { Schema } from 'mongoose';
import type { Document, Types } from 'mongoose';

export type CommissionType = 'earned' | 'adjustment' | 'reversal';

export interface ICommissionTransaction extends Document {
  employeeId: Types.ObjectId;
  employeeProfileId: Types.ObjectId;
  salesEntryId?: Types.ObjectId;
  cycleId: Types.ObjectId;
  cycleKey: string;
  type: CommissionType;
  rateBps: number;
  baseAmountPaise: number;
  amountPaise: number; // Positive for earned, signed for adjustments/reversals
  description: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const commissionTransactionSchema = new Schema<ICommissionTransaction>(
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
    salesEntryId: {
      type: Schema.Types.ObjectId,
      ref: 'SalesEntry',
      index: true,
    },
    cycleId: {
      type: Schema.Types.ObjectId,
      ref: 'TargetCycle',
      required: true,
      index: true,
    },
    cycleKey: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ['earned', 'adjustment', 'reversal'],
      required: true,
      index: true,
    },
    rateBps: {
      type: Number,
      required: true,
    },
    baseAmountPaise: {
      type: Number,
      required: true,
    },
    amountPaise: {
      type: Number,
      required: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

// Guarantees commission is never duplicated for the same sales entry
commissionTransactionSchema.index(
  { salesEntryId: 1, type: 1 },
  {
    unique: true,
    partialFilterExpression: {
      salesEntryId: { $type: 'objectId' },
      type: 'earned',
    },
  }
);
commissionTransactionSchema.index({ employeeId: 1, createdAt: -1 });

export const CommissionTransaction = mongoose.model<ICommissionTransaction>(
  'CommissionTransaction',
  commissionTransactionSchema
);
