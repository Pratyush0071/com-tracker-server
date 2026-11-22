import bcrypt from 'bcryptjs';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { env } from '../config/env.js';
import { User } from '../models/User.js';
import { getOrCreateSystemSettings, getOrCreateTargetConfig } from '../services/cycleService.js';

async function run() {
  const username = (process.argv[2] || env.adminUsername || 'admin').toLowerCase();
  const email = (process.argv[3] || env.adminEmail || 'admin@lakshyasales.local').toLowerCase();
  const password = process.argv[4] || env.adminPassword;

  if (!password || password.length < 8) {
    console.error(
      'Error: Provide a strong ADMIN_PASSWORD (min 8 chars) in .env or as the 3rd CLI argument.'
    );
    console.error('Usage: npm run seed:admin -- <username> <email> <password>');
    process.exit(1);
  }

  await connectDatabase();
  await getOrCreateSystemSettings();
  await getOrCreateTargetConfig();

  const existing = await User.findOne({
    $or: [{ username }, { email }],
    isDeleted: false,
  });

  if (existing) {
    console.log(`Admin user already exists (${existing.username} / ${existing.email}).`);
  } else {
    const passwordHash = await bcrypt.hash(password, 12);
    await User.create({
      username,
      email,
      passwordHash,
      role: 'admin',
      fullName: 'System Administrator',
      isActive: true,
      isDeleted: false,
    });
    console.log(`Admin user created successfully: ${username} (${email})`);
  }

  await disconnectDatabase();
}

run().catch((err) => {
  console.error('Failed to seed admin:', err);
  process.exit(1);
});
