import { createApp } from './app.js';
import { describeConfigError, getConfig } from './config.js';
import { logOperatorWarnings } from './auth/notices.js';

let config;
try {
  config = getConfig();
} catch (e) {
  // One clear line naming the missing/invalid key (never the value), so a failed container start is never silent.
  console.error(`STARTUP ERROR: ${describeConfigError(e)}`);
  process.exit(1);
}
const app = createApp();
logOperatorWarnings(config);
setInterval(() => logOperatorWarnings(getConfig()), 24 * 3600 * 1000).unref();   // keeps the secret-expiry warning in the logs every day
app.listen(config.port, '0.0.0.0', () => {
  console.log(`NamRA voting API listening on 0.0.0.0:${config.port} (auth=${config.authMode}, env=${config.nodeEnv})`);
});
