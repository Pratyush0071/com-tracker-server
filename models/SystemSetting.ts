import mongoose, { Schema } from 'mongoose';
import type { Document, Types } from 'mongoose';

export interface ISystemSetting extends Document {
  key: string;
  companyName: string;
  commissionRateBps: number; // 100 bps = 1%
  allowEmployeeEditEntry: boolean;
  allowEmployeeDeleteEntry: boolean;
  employeeEditWindowHours: number;
  withdrawalDayOfMonth: number;
  defaultTargetIncentivePaise: number;
  jwtSigningSecret?: string;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const systemSettingSchema = new Schema<ISystemSetting>(
  {
    key: {
      type: String,
      default: 'global',
      unique: true,
    },
    companyName: {
      type: String,
      default: 'Commission Tracker',
      trim: true,
    },
    commissionRateBps: {
      type: Number,
      default: 100, // 1.00%
      min: 0,
      max: 5000,
    },
    allowEmployeeEditEntry: {
      type: Boolean,
      default: false,
    },
    allowEmployeeDeleteEntry: {
      type: Boolean,
      default: false,
    },
    employeeEditWindowHours: {
      type: Number,
      default: 24,
      min: 1,
      max: 720,
    },
    withdrawalDayOfMonth: {
      type: Number,
      default: 20,
      min: 1,
      max: 28,
    },
    defaultTargetIncentivePaise: {
      type: Number,
      default: 50000, // ₹500
      min: 0,
    },
    jwtSigningSecret: {
      type: String,
      select: false,
    },
    updatedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

export const SystemSetting = mongoose.model<ISystemSetting>('SystemSetting', systemSettingSchema);
