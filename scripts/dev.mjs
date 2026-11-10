// Runs API (tsx watch) and Vite together without extra dependencies.
import { spawn } from 'node:child_process';
const run = (name, args) => {
  const p = spawn('npm', args, { stdio: 'inherit', shell: true });
  p.on('exit', (c) => { console.log(`[${name}] exited (${c})`); process.exit(c ?? 0); });
  return p;
};
const procs = [run('server', ['run', 'dev', '-w', 'server']), run('client', ['run', 'dev', '-w', 'client'])];
process.on('SIGINT', () => procs.forEach((p) => p.kill()));
