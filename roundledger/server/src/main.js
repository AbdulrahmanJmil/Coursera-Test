import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
if (config.problems.length) {
  for (const p of config.problems) console.error(`[config] ${p}`);
  if (config.isProduction) process.exit(1);
}
if (!config.encryptionKey) console.warn('[config] APP_ENCRYPTION_KEY is not set: AI provider keys cannot be stored until it is.');

const { server, db } = createApp(config);
server.listen(config.port, config.host, () => {
  console.log(`RoundLedger server listening on http://${config.host}:${config.port} (dashboard: /admin/)`);
});

const shutdown = (sig) => {
  console.log(`${sig} received, shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
