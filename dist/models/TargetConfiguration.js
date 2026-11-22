import mongoose, { Schema } from 'mongoose';
const milestoneSchema = new Schema({
    order: { type: Number, required: true },
    amountPaise: { type: Number, required: true, min: 100 },
    label: { type: String, required: true, trim: true },
    defaultIncentivePaise: { type: Number, default: 50000, min: 0 },
}, { _id: false });
const targetConfigurationSchema = new Schema({
    key: {
        type: String,
        default: 'default',
        unique: true,
    },
    milestones: {
        type: [milestoneSchema],
        default: [
            { order: 1, amountPaise: 50000000, label: '₹5 Lakh', defaultIncentivePaise: 50000 },
            { order: 2, amountPaise: 80000000, label: '₹8 Lakh', defaultIncentivePaise: 50000 },
            { order: 3, amountPaise: 100000000, label: '₹10 Lakh', defaultIncentivePaise: 100000 },
            { order: 4, amountPaise: 150000000, label: '₹15 Lakh', defaultIncentivePaise: 150000 },
            { order: 5, amountPaise: 200000000, label: '₹20 Lakh', defaultIncentivePaise: 200000 },
        ],
    },
    initialTargetPaise: {
        type: Number,
        default: 50000000, // ₹5,00,000
        min: 100,
    },
    dailyCalculationMode: {
        type: String,
        enum: ['remaining_days', 'inclusive_today'],
        default: 'remaining_days',
    },
    isActive: {
        type: Boolean,
        default: true,
    },
    updatedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
    },
}, { timestamps: true });
export const TargetConfiguration = mongoose.model('TargetConfiguration', targetConfigurationSchema);
