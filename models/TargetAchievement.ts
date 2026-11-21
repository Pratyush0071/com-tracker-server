import mongoose, { Schema } from 'mongoose';
import type { Document, Types } from 'mongoose';

export interface ITargetAchievement extends Document {
  employeeId: Types.ObjectId;
  employeeProfileId: Types.ObjectId;
  employeeCode: string;
  employeeName: string;
  cycleId: Types.ObjectId;
  cycleKey: string;
  milestoneAmountPaise: number;
  milestoneLabel: string;
  achievedAtSalesPaise: number;
  achievedAt: Date;
  incentiveGranted: boolean;
  incentiveId?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const targetAchievementSchema = new Schema<ITargetAchievement>(
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
      required: true,
      index: true,
    },
    cycleKey: {
      type: String,
      required: true,
    },
    milestoneAmountPaise: {
      type: Number,
      required: true,
      min: 1,
    },
    milestoneLabel: {
      type: String,
      required: true,
    },
    achievedAtSalesPaise: {
      type: Number,
      required: true,
    },
    achievedAt: {
      type: Date,
      default: Date.now,
    },
    incentiveGranted: {
      type: Boolean,
      default: false,
      index: true,
    },
    incentiveId: {
      type: Schema.Types.ObjectId,
      ref: 'IncentiveTransaction',
    },
  },
  { timestamps: true }
);

targetAchievementSchema.index(
  { employeeId: 1, cycleId: 1, milestoneAmountPaise: 1 },
  { unique: true }
);

export const TargetAchievement = mongoose.model<ITargetAchievement>(
  'TargetAchievement',
  targetAchievementSchema
);
