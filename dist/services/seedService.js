import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { SystemSetting } from '../models/SystemSetting.js';
import { getOrCreateSystemSettings, getOrCreateTargetConfig } from './cycleService.js';
import { env, setRuntimeJwtSecret } from '../config/env.js';
export async function bootstrapSystemDefaults() {
    await getOrCreateSystemSettings();
    await getOrCreateTargetConfig();
    if (!process.env.JWT_SECRET) {
        const secretDoc = await SystemSetting.findOne({ key: 'global' }).select('+jwtSigningSecret');
        if (secretDoc) {
            if (!secretDoc.jwtSigningSecret) {
                secretDoc.jwtSigningSecret = crypto.randomBytes(48).toString('hex');
                await secretDoc.save();
            }
            setRuntimeJwtSecret(secretDoc.jwtSigningSecret);
        }
    }
    // Seed initial admin only if zero admin accounts exist AND an admin password is available
    // (from env.adminPassword, or in non-production dev mode a documented initial setup password)
    const existingAdmin = await User.findOne({ role: 'admin', isDeleted: false });
    if (!existingAdmin) {
        const devFallback = env.nodeEnv !== 'production' ? 'Admin@12345' : '';
        const password = env.adminPassword || devFallback;
        if (password) {
            const passwordHash = await bcrypt.hash(password, 12);
            await User.create({
                username: env.adminUsername.toLowerCase(),
                email: env.adminEmail.toLowerCase(),
                passwordHash,
                role: 'admin',
                fullName: 'System Administrator',
                isActive: true,
                isDeleted: false,
            });
            console.log(`[Seed] Initial Admin created (${env.adminUsername} / ${env.adminEmail}). Please change the password after first login.`);
        }
        else {
            console.log('[Seed] No Admin account exists. Use /api/auth/setup-admin or run `npm run seed:admin` with ADMIN_PASSWORD set.');
        }
    }
}
