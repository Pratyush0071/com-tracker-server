
import app from './app.ts';
import { env } from './config/env.ts';

const port = Number(process.env.PORT || env.port || 5000);

app.listen(port, '0.0.0.0', () => {
  console.log(
    `[API Server] Commission Tracker running on port ${port}`
  );
});
