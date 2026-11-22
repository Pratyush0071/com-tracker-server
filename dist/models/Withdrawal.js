import mongoose, { Schema } from 'mongoose';
const withdrawalSchema = new Schema({
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
}, { timestamps: true });
withdrawalSchema.index({ employeeId: 1, status: 1 });
withdrawalSchema.index({ requestedAt: -1 });
export const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);
