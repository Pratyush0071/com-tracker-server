import mongoose, { Schema } from 'mongoose';
import type { Document, Types } from 'mongoose';

export interface IEmployeeProfile extends Document {
  userId: Types.ObjectId;
  employeeCode: string;
  fullName: string;
  email: string;
  mobile: string;
  joiningDate: string; // YYYY-MM-DD IST
  department: string;
  designation: string;
  upiId: string;
  bankDetails: string;
  isActive: boolean;
  isDeleted: boolean;
  deletedAt?: Date;
  lifetimeSalesPaise: number;
  totalCommissionPaise: number;
  totalIncentivesPaise: number;
  totalWithdrawnPaise: number;
  approvedUnpaidPaise: number;
  pendingWithdrawalPaise: number;
  targetCycleDay?: number;
  customTargetAmountPaise?: number;
  createdAt: Date;
  updatedAt: Date;
}

const employeeProfileSchema = new Schema<IEmployeeProfile>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
      index: true,
    },
    employeeCode: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    fullName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    mobile: {
      type: String,
      default: '',
      trim: true,
      maxlength: 20,
    },
    joiningDate: {
      type: String,
      required: true,
    },
    department: {
      type: String,
      default: 'Sales',
      trim: true,
    },
    designation: {
      type: String,
      default: 'Sales Executive',
      trim: true,
    },
    upiId: {
      type: String,
      default: '',
      trim: true,
    },
    bankDetails: {
      type: String,
      default: '',
      trim: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    deletedAt: {
      type: Date,
    },
    lifetimeSalesPaise: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalCommissionPaise: {
      type: Number,
      default: 0,
    },
    totalIncentivesPaise: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalWithdrawnPaise: {
      type: Number,
      default: 0,
      min: 0,
    },
    approvedUnpaidPaise: {
      type: Number,
      default: 0,
      min: 0,
    },
    pendingWithdrawalPaise: {
      type: Number,
      default: 0,
      min: 0,
    },
    targetCycleDay: {
      type: Number,
      min: 1,
      max: 28,
    },
    customTargetAmountPaise: {
      type: Number,
      min: 0,
    },
  },
  { timestamps: true }
);

employeeProfileSchema.index({ isDeleted: 1, isActive: 1 });
employeeProfileSchema.index({ fullName: 'text', employeeCode: 'text', email: 'text' });

export const EmployeeProfile = mongoose.model<IEmployeeProfile>(
  'EmployeeProfile',
  employeeProfileSchema
);
