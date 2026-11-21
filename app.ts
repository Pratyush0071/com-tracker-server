import express from 'express';
import cors from 'cors';
import { apiLimiter } from './middleware/rateLimit.ts';
import { sanitizeInput } from './middleware/sanitize.ts';
import { errorHandler } from './middleware/errorHandler.ts';
import authRoutes from './routes/authRoutes.ts';
import employeeRoutes from './routes/employeeRoutes.ts';
import adminRoutes from './routes/adminRoutes.ts';
import { env } from './config/env.ts';

export function createExpressApp() {
  const app = express();

  app.set('trust proxy', 1);

  const allowedOrigins = env.corsOrigin
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin: allowedOrigins.length > 0 ? allowedOrigins : true,
      credentials: true,
    })
  );

  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(sanitizeInput);
  app.use('/api', apiLimiter);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/employee', employeeRoutes);
  app.use('/api/admin', adminRoutes);

  app.use('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found' });
  });

  app.use(errorHandler);

  return app;
}
