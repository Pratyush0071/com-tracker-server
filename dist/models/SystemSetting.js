import mongoose, { Schema } from 'mongoose';
const systemSettingSchema = new Schema({
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
}, { timestamps: true });
export const SystemSetting = mongoose.model('SystemSetting', systemSettingSchema);
