/**
 * Delegated Microsoft Graph token via the OAuth device-code flow (the signed-in person approves in a browser).
 * The token lives in memory for the script run only: it is never printed, written to disk or put in an error message.
 */
export class PublicClientDisabled extends Error {}
export class DeviceFlowError extends Error {}

export const IT_MESSAGE_PUBLIC_CLIENT =
  'Device-code sign-in is not available for this app registration. Ask IT to either (1) enable "Allow public client flows" ' +
  '(Authentication > Advanced settings) on the NamRA Voting app registration, or (2) add the Web redirect URI ' +
  'http://localhost:3001/auth/callback so the lookup can run locally.';

export interface DeviceDeps {
  tenantId: string; clientId: string; clientSecret?: string; scope: string;
  authorityBase?: string; fetch?: typeof fetch; sleep?: (ms: number) => Promise<void>; now?: () => number;
  /** Receives the sign-in instruction (URL + code). Contains no secret. */
  announce: (message: string) => void;
}

const disabled = /AADSTS7000218|AADSTS70002\b|AADSTS700025|unauthorized_client|invalid_client/i;

export async function deviceCodeToken(d: DeviceDeps): Promise<string> {
  const f = d.fetch ?? fetch;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  const base = `${(d.authorityBase ?? 'https://login.microsoftonline.com').replace(/\/$/, '')}/${d.tenantId}/oauth2/v2.0`;
  const post = async (path: string, body: Record<string, string>) => {
    // A dropped connection while waiting for the person to approve must not abort the sign-in: retry a few times.
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await f(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
        return (await r.json().catch(() => ({}))) as Record<string, unknown>;
      } catch (e) {
        if (attempt >= 5) throw new DeviceFlowError(`Network error talking to Microsoft sign-in (${String((e as { cause?: { code?: string } })?.cause?.code ?? 'unknown')})`);
        await sleep(Math.min(15_000, 2 ** attempt * 1000));
      }
    }
  };
  const code = await post('devicecode', { client_id: d.clientId, scope: d.scope });
  if (typeof code.device_code !== 'string') {
    const why = `${code.error ?? ''} ${String(code.error_description ?? '')}`;
    if (disabled.test(why)) throw new PublicClientDisabled(IT_MESSAGE_PUBLIC_CLIENT);
    throw new DeviceFlowError(`Could not start the device-code sign-in: ${String(code.error ?? 'unknown error')}`);
  }
  d.announce(String(code.message ?? `Open ${String(code.verification_uri)} and enter the code ${String(code.user_code)}`));
  const interval = Math.max(1, Number(code.interval) || 5) * 1000;
  const until = now() + (Number(code.expires_in) || 900) * 1000;
  while (now() < until) {
    await sleep(interval);
    const t = await post('token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: d.clientId, device_code: code.device_code,
      ...(d.clientSecret ? { client_secret: d.clientSecret } : {}),
    });
    if (typeof t.access_token === 'string') return t.access_token;
    const err = String(t.error ?? '');
    if (err === 'authorization_pending' || err === 'slow_down') continue;
    const why = `${err} ${String(t.error_description ?? '')}`;
    if (disabled.test(why)) throw new PublicClientDisabled(IT_MESSAGE_PUBLIC_CLIENT);
    throw new DeviceFlowError(`Device-code sign-in failed: ${err || 'unknown error'}${/expired/.test(err) ? ' (the code expired before it was approved)' : ''}`);
  }
  throw new DeviceFlowError('Device-code sign-in timed out: the code was not approved in time');
}
