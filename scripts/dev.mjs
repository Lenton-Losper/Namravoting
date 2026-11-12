// Runs API (tsx watch) and Vite together without extra dependencies.
import { spawn } from 'node:child_process';
// Running the dev script IS the explicit opt-in to the dev identity picker (the server refuses AUTH_MODE=dev without it).
const run = (name, args) => {
  const p = spawn('npm', args, { stdio: 'inherit', shell: true, env: { ...process.env, ALLOW_DEV_AUTH: 'true' } });
  p.on('exit', (c) => { console.log(`[${name}] exited (${c})`); process.exit(c ?? 0); });
  return p;
};
const procs = [run('server', ['run', 'dev', '-w', 'server']), run('client', ['run', 'dev', '-w', 'client'])];
process.on('SIGINT', () => procs.forEach((p) => p.kill()));
