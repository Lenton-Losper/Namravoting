// `npm run dev:lan`: same as `npm run dev`, but reachable from a phone on the same Wi-Fi/LAN.
//  - Vite listens on 0.0.0.0:5173 (strict port, so the QR/URL never silently point at another port)
//  - PUBLIC_BASE_URL is set for THIS RUN ONLY (child-process env; .env is never touched), so share links and QR codes
//    point at the LAN address. `npm run dev` keeps using localhost.
// Override the detected address with:  LAN_IP=192.168.1.20 npm run dev:lan
import { spawn } from 'node:child_process';
import os from 'node:os';

const PORT = 5173;
const VIRTUAL = /vethernet|wsl|docker|virtualbox|vmware|vmnet|hyper-v|default switch|loopback|bluetooth|tailscale|zerotier|vpn|tap-|tun/i;

function detectLanIp() {
  if (process.env.LAN_IP) return process.env.LAN_IP;
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;   // skip loopback + link-local
      candidates.push({ name, ip: a.address, preferred: /wi-?fi|wlan|wireless|ethernet|^en\d|^eth/i.test(name) });
    }
  }
  candidates.sort((a, b) => Number(b.preferred) - Number(a.preferred));
  return candidates[0]?.ip ?? null;
}

const ip = detectLanIp();
if (!ip) {
  console.error('Could not find a LAN IPv4 address (are you connected to Wi-Fi/Ethernet?). Set LAN_IP=<address> and retry.');
  process.exit(1);
}
const url = `http://${ip}:${PORT}`;

const run = (name, args, env = {}) => {
  const p = spawn('npm', args, { stdio: 'inherit', shell: true, env: { ...process.env, ...env } });
  p.on('exit', (c) => { console.log(`[${name}] exited (${c})`); process.exit(c ?? 0); });
  return p;
};

const procs = [
  // The LAN script is the explicit opt-in to the dev identity picker AND to listening beyond localhost.
  run('server', ['run', 'dev', '-w', 'server'], { PUBLIC_BASE_URL: url, ALLOW_DEV_AUTH: 'true', DEV_LAN: 'true' }),
  run('client', ['run', 'dev', '-w', 'client', '--', '--host', '0.0.0.0', '--port', String(PORT), '--strictPort']),
];

setTimeout(() => {
  const bar = '='.repeat(url.length + 24);
  console.log(`\n${bar}\n  Open on your phone: ${url}\n${bar}`);
  console.log('  Phone must be on the same Wi-Fi. If it will not load, allow inbound TCP 5173 in Windows Firewall (see README).\n');
}, 4000);

process.on('SIGINT', () => procs.forEach((p) => p.kill()));
