import { OAuth2Client, type Credentials } from 'google-auth-library';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export async function saveJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function loadClient(path: string) {
  let value: { installed?: { client_id?: string; client_secret?: string } };
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('oauth_client_unreadable_or_invalid_json');
  }
  if (!value?.installed?.client_id || !value.installed.client_secret)
    throw new Error('oauth_desktop_client_required');
  return value.installed as { client_id: string; client_secret: string };
}

/** Short-lived Desktop loopback listener, never a Web/Next.js login service. */
async function authorize(clientId: string, clientSecret: string) {
  const state = randomBytes(32).toString('hex');
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('oauth_loopback_unavailable');
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  const client = new OAuth2Client({
    clientId,
    clientSecret,
    redirectUri,
    transporterOptions: { timeout: 30_000, retry: false },
  });
  const verifier = await client.generateCodeVerifierAsync();
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('oauth_authorization_timeout')), 300_000);
      server.on('request', (request, response) => {
        const url = new URL(request.url ?? '/', redirectUri);
        if (url.pathname !== '/oauth2callback' || url.searchParams.get('state') !== state) {
          response.writeHead(400).end('Invalid authorization callback.');
          return;
        }
        const code = url.searchParams.get('code');
        clearTimeout(timeout);
        if (url.searchParams.has('error') || !code) {
          response.writeHead(400).end('Authorization declined. Return to the terminal.');
          reject(new Error('oauth_authorization_declined'));
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('Authorization received. You may close this tab and return to the terminal.');
        resolve(code);
      });
      const url = client.generateAuthUrl({
        scope: [GMAIL_SCOPE],
        access_type: 'offline',
        prompt: 'consent',
        state,
        code_challenge: verifier.codeChallenge,
        code_challenge_method: 'S256' as import('google-auth-library').CodeChallengeMethod,
      });
      // This URL contains the public Client ID and PKCE challenge, never the secret or tokens.
      console.error('Open this Google authorization URL in your browser (expires in 5 minutes):');
      console.error(url);
    });
    const { tokens } = await client.getToken({ code, codeVerifier: verifier.codeVerifier });
    client.setCredentials(tokens);
    return client;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function gmailAuth(
  clientPath: string,
  tokenPath: string,
  options: { interactive?: boolean } = {},
) {
  const config = await loadClient(clientPath);
  let client = new OAuth2Client({
    clientId: config.client_id,
    clientSecret: config.client_secret,
    transporterOptions: { timeout: 30_000, retry: false },
  });
  let stored: { clientId: string; scope: string; tokens: Credentials } | null = null;
  try {
    stored = JSON.parse(await readFile(tokenPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('oauth_token_unreadable');
  }
  if (stored) {
    if (stored.clientId !== config.client_id || stored.scope !== GMAIL_SCOPE)
      throw new Error('oauth_token_client_or_scope_mismatch');
    client.setCredentials(stored.tokens);
    try {
      // Official library refreshes expired credentials. An invalid/revoked grant requires consent again.
      await client.getAccessToken();
    } catch (error) {
      const data = (error as { response?: { data?: { error?: string } } }).response?.data;
      if (data?.error !== 'invalid_grant') throw new Error('oauth_token_refresh_failed');
      console.error('Stored authorization has expired or been revoked; consent is required again.');
      stored = null;
    }
  }
  if (!stored) {
    if (options.interactive === false) throw new Error('oauth_authorization_required');
    client = await authorize(config.client_id, config.client_secret);
  }
  const save = () =>
    saveJson(tokenPath, {
      clientId: config.client_id,
      scope: GMAIL_SCOPE,
      tokens: client.credentials,
    });
  await save();
  return { client, save };
}
