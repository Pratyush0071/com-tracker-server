import mongoose, { Schema } from 'mongoose';
import type { Document, Types } from 'mongoose';

export type SalesEntryStatus = 'active' | 'edited' | 'deleted';

export interface ISalesEntry extends Document {
  employeeId: Types.ObjectId;
  employeeProfileId: Types.ObjectId;
  employeeCode: string;
  employeeName: string;
  cycleId: Types.ObjectId;
  cycleKey: string;
  orderName: string;
  productName: string;
  amountPaise: number;
  commissionRateBps: number;
  commissionPaise: number;
  entryDateIST: string; // YYYY-MM-DD
  entryTimeIST: string; // HH:mm:ss
  entryTimestamp: Date;
  status: SalesEntryStatus;
  isDeleted: boolean;
  clientRequestId?: string;
  createdBy: Types.ObjectId;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const salesEntrySchema = new Schema<ISalesEntry>(
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
      trim: true,
    },
    employeeName: {
      type: String,
      required: true,
      trim: true,
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
      index: true,
    },
    orderName: {
      type: String,
      default: '',
      trim: true,
      maxlength: 200,
    },
    productName: {
      type: String,
      default: '',
      trim: true,
      maxlength: 200,
    },
    amountPaise: {
      type: Number,
      required: true,
      min: 1,
    },
    commissionRateBps: {
      type: Number,
      required: true,
      min: 0,
    },
    commissionPaise: {
      type: Number,
      required: true,
      min: 0,
    },
    entryDateIST: {
      type: String,
      required: true,
      index: true,
    },
    entryTimeIST: {
      type: String,
      required: true,
    },
    entryTimestamp: {
      type: Date,
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['active', 'edited', 'deleted'],
      default: 'active',
      index: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    clientRequestId: {
      type: String,
      sparse: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

salesEntrySchema.index({ employeeId: 1, entryDateIST: -1 });
salesEntrySchema.index({ employeeId: 1, cycleId: 1, isDeleted: 1 });
salesEntrySchema.index({ entryDateIST: 1, isDeleted: 1 });
salesEntrySchema.index(
  { employeeId: 1, clientRequestId: 1 },
  { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } }
);

export const SalesEntry = mongoose.model<ISalesEntry>('SalesEntry', salesEntrySchema);
