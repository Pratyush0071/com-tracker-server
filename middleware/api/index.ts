
import express from 'express';
import { createExpressApp } from '../app.ts';
import { connectDatabase } from '../config/db.ts';
import { bootstrapSystemDefaults } from '../services/seedService.ts';
import { syncAllEmployeeCycles } from '../services/cycleService.ts';

const app = express();

let initialization: Promise<void> | null = null;

async function initializeDatabase() {
  await connectDatabase();
  await bootstrapSystemDefaults();
  await syncAllEmployeeCycles();

  console.log('[Vercel] Database initialized successfully');
}

app.use('/api', async (_req, res, next) => {
  try {
    if (!initialization) {
      initialization = initializeDatabase().catch((error) => {
        initialization = null;
        throw error;
      });
    }

    await initialization;
    next();
  } catch (error) {
    console.error('[Vercel DB Error]', error);

    res.status(503).json({
      error: 'Database initialization failed',
    });
  }
});

app.use(createExpressApp());

export default app;
