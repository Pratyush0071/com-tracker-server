import mongoose, { Schema } from 'mongoose';
const userSchema = new Schema({
    username: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
        minlength: 3,
        maxlength: 64,
    },
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
        maxlength: 120,
    },
    passwordHash: {
        type: String,
        required: true,
    },
    role: {
        type: String,
        enum: ['admin', 'employee'],
        required: true,
        index: true,
    },
    fullName: {
        type: String,
        required: true,
        trim: true,
        maxlength: 120,
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
    lastLoginAt: {
        type: Date,
    },
}, { timestamps: true });
userSchema.index({ username: 1, isDeleted: 1 });
userSchema.index({ email: 1, isDeleted: 1 });
export const User = mongoose.model('User', userSchema);
