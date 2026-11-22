import mongoose, { Schema } from 'mongoose';
const cycleMilestoneSchema = new Schema({
    order: { type: Number, required: true },
    amountPaise: { type: Number, required: true },
    label: { type: String, required: true },
    defaultIncentivePaise: { type: Number, default: 50000 },
}, { _id: false });
const targetCycleSchema = new Schema({
    cycleKey: {
        type: String,
        required: true,
        index: true,
    },
    label: {
        type: String,
        required: true,
    },
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
    startDateIST: {
        type: String,
        required: true,
    },
    endDateIST: {
        type: String,
        required: true,
    },
    startTimestamp: {
        type: Date,
        required: true,
    },
    endTimestamp: {
        type: Date,
        required: true,
    },
    initialTargetPaise: {
        type: Number,
        required: true,
        min: 0,
    },
    currentTargetPaise: {
        type: Number,
        required: true,
        min: 0,
    },
    milestonesSnapshot: {
        type: [cycleMilestoneSchema],
        default: [],
    },
    totalSalesPaise: {
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
    withdrawnPaise: {
        type: Number,
        default: 0,
        min: 0,
    },
    status: {
        type: String,
        enum: ['active', 'closed'],
        default: 'active',
        index: true,
    },
    closedAt: {
        type: Date,
    },
    visibilityStartAt: {
        type: Date,
    },
}, { timestamps: true });
targetCycleSchema.index({ employeeId: 1, cycleKey: 1 }, { unique: true });
targetCycleSchema.index({ employeeId: 1, status: 1 });
export const TargetCycle = mongoose.model('TargetCycle', targetCycleSchema);
