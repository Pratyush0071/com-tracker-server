
import express from 'express';
import cors from 'cors';

import { apiLimiter } from './middleware/rateLimit.ts';
import { sanitizeInput } from './middleware/sanitize.ts';
import { errorHandler } from './middleware/errorHandler.ts';

import authRoutes from './routes/authRoutes.ts';
import employeeRoutes from './routes/employeeRoutes.ts';
import adminRoutes from './routes/adminRoutes.ts';

import { env } from './config/env.ts';
import { connectDatabase } from './config/db.ts';
import { bootstrapSystemDefaults } from './services/seedService.ts';
import { syncAllEmployeeCycles } from './services/cycleService.ts';

// Initialize database only once per server instance.
let initializationPromise: Promise<void> | null = null;

function initializeApplication(): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      await connectDatabase();
      await bootstrapSystemDefaults();
      await syncAllEmployeeCycles();

      console.log('[APP] Application initialized successfully');
    })().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }

  return initializationPromise;
}

export function createExpressApp() {
  const app = express();

  app.set('trust proxy', 1);

  const allowedOrigins = env.corsOrigin
    .split(',')
    .map((origin) => origin.trim())
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

  // Basic health endpoint
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      environment: env.nodeEnv,
    });
  });

  // Ensure database and application initialization before API requests.
  app.use('/api', (req, res, next) => {
    initializeApplication()
      .then(() => next())
      .catch((error) => {
        console.error('[APP INIT ERROR]', error);

        res.status(503).json({
          ok: false,
          error: 'Database or application initialization failed.',
        });
      });
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/employee', employeeRoutes);
  app.use('/api/admin', adminRoutes);

  app.use('/api/*', (_req, res) => {
    res.status(404).json({
      error: 'API endpoint not found',
    });
  });

  app.use(errorHandler);

  return app;
}

// Vercel serverless entrypoint
const app = createExpressApp();

export default app;
