import { createApp } from './app.js';
import { getConfig } from './config.js';

const config = getConfig();
const app = createApp();
app.listen(config.port, () => {
  console.log(`NamRA voting API listening on :${config.port} (auth=${config.authMode}, env=${config.nodeEnv})`);
});
