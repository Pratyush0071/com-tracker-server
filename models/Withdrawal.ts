import mongoose, { Schema } from 'mongoose';
import type { Document, Types } from 'mongoose';

export type WithdrawalStatus = 'pending' | 'approved' | 'rejected' | 'paid';

export interface IWithdrawal extends Document {
  employeeId: Types.ObjectId;
  employeeProfileId: Types.ObjectId;
  employeeCode: string;
  employeeName: string;
  cycleId?: Types.ObjectId;
  cycleKey?: string;
  amountPaise: number;
  status: WithdrawalStatus;
  requestedAt: Date;
  requestDateIST: string;
  employeeNote: string;
  reviewedAt?: Date;
  reviewedBy?: Types.ObjectId;
  reviewedByName?: string;
  rejectionReason?: string;
  paidAt?: Date;
  paidBy?: Types.ObjectId;
  paidByName?: string;
  paymentMethod?: string;
  paymentReference?: string;
  paymentNotes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const withdrawalSchema = new Schema<IWithdrawal>(
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
    amountPaise: {
      type: Number,
      required: true,
      min: 100,
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'paid'],
      default: 'pending',
      index: true,
    },
    requestedAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    requestDateIST: {
      type: String,
      required: true,
    },
    employeeNote: {
      type: String,
      default: '',
      trim: true,
      maxlength: 300,
    },
    reviewedAt: { type: Date },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedByName: { type: String },
    rejectionReason: { type: String, trim: true, maxlength: 300 },
    paidAt: { type: Date },
    paidBy: { type: Schema.Types.ObjectId, ref: 'User' },
    paidByName: { type: String },
    paymentMethod: { type: String, trim: true, maxlength: 100 },
    paymentReference: { type: String, trim: true, maxlength: 150 },
    paymentNotes: { type: String, trim: true, maxlength: 300 },
  },
  { timestamps: true }
);

withdrawalSchema.index({ employeeId: 1, status: 1 });
withdrawalSchema.index({ requestedAt: -1 });

export const Withdrawal = mongoose.model<IWithdrawal>('Withdrawal', withdrawalSchema);
