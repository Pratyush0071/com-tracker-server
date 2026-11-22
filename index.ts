import express from 'express';
import { connectDatabase } from './config/db.js';
import { env } from './config/env.js';
import { createExpressApp } from './app.js';
import { bootstrapSystemDefaults } from './services/seedService.js';
import { syncAllEmployeeCycles } from './services/cycleService.js';

async function startStandaloneApiServer() {
  const port = Number(process.env.PORT || 5000);
  let dbReady = false;
  let dbError: Error | null = null;

  const dbInitPromise = (async () => {
    await connectDatabase();
    await bootstrapSystemDefaults();
    await syncAllEmployeeCycles();
    dbReady = true;

    const CYCLE_SYNC_INTERVAL_MS = 15 * 60 * 1000;
    setInterval(() => {
      syncAllEmployeeCycles().catch((err) => {
        console.error('[CycleSync] Background cycle sync failed:', err);
      });
    }, CYCLE_SYNC_INTERVAL_MS);
  })().catch((err) => {
    dbError = err instanceof Error ? err : new Error(String(err));
    console.error('[DB Init Error]', err);
  });

  const rootApp = express();

  rootApp.get('/api/health', (_req, res) => {
    if (dbError) {
      res.status(503).json({ ok: false, error: dbError.message });
      return;
    }
    res.json({ ok: true, dbReady, timestamp: new Date().toISOString() });
  });

  rootApp.use('/api', async (_req, res, next) => {
    if (!dbReady && !dbError) {
      await dbInitPromise;
    }
    if (dbError) {
      res.status(503).json({ error: 'Database is initializing or unavailable.' });
      return;
    }
    next();
  });

  const apiApp = createExpressApp();
  rootApp.use(apiApp);

  rootApp.listen(port, '0.0.0.0', () => {
    console.log(`[API Server] Commission Tracker API running on http://localhost:${port} (${env.nodeEnv})`);
  });
}

startStandaloneApiServer().catch((err) => {
  console.error('[Startup Error]', err);
  process.exit(1);
});
