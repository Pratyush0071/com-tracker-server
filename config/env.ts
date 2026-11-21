import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const processFallbackJwtSecret = crypto.randomBytes(48).toString('hex');

export const env = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGODB_URI || '',
  jwtSecret: process.env.JWT_SECRET || processFallbackJwtSecret,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',
  appUrl: process.env.APP_URL || 'http://localhost:3000',
  corsOrigin: process.env.CORS_ORIGIN || '',
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminEmail: process.env.ADMIN_EMAIL || 'admin@lakshyasales.local',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  companyName: process.env.COMPANY_NAME || 'Commission Tracker',
};

export function setRuntimeJwtSecret(secret: string): void {
  if (!process.env.JWT_SECRET && secret) {
    env.jwtSecret = secret;
  }
}
