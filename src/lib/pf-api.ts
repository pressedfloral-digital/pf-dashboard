import { reportingFetch } from '@/lib/pf-budget';
/**
 * Pressed Floral API client
 * All calls are server-side only — credentials never reach the browser.
 */

type ApiConfig = {
  url: string;
  email: string;
  password: string;
};

function getApiConfig(): ApiConfig {
  const url = process.env.PF_API_URL?.replace(/\/$/, '');
  const email = process.env.PF_API_EMAIL;
  const password = process.env.PF_API_PASSWORD;

  if (!url || !email || !password) {
    throw new Error(
      'PF API is not configured. Set PF_API_URL, PF_API_EMAIL, and PF_API_PASSWORD.'
    );
  }

  return { url, email, password };
}

let cachedToken: { token: string; expiresAt: number } | null = null;
// Requests that start before the first login finishes wait on it instead of
// each logging in (a page load can fire dozens at once).
let pendingLogin: Promise<string> | null = null;

async function login(): Promise<string> {
  const { url, email, password } = getApiConfig();
  const res = await reportingFetch(`${url}/Authentication/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(30000),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`PF API login failed → ${res.status}`);
  const json = await res.json();
  const token = json.jwt ?? json.token ?? json.accessToken ?? json.access_token;
  if (!token) throw new Error('PF API login failed (no token in response)');

  // Cache token for 50 minutes
  cachedToken = { token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return token;
}

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  pendingLogin ??= login().finally(() => { pendingLogin = null; });
  return pendingLogin;
}

const pendingReads = new Map<string, Promise<unknown>>();
export function pfGet<T>(path: string, options?: { fresh?: boolean }): Promise<T> {
  const key = `${options?.fresh ? 'fresh' : 'cached'}:${path}`;
  const pending = pendingReads.get(key);
  if (pending) return pending as Promise<T>;
  if (pendingReads.size >= 128) return Promise.reject(new Error('PF reporting is busy.'));
  const request = loadPfGet<T>(path, options).finally(() => pendingReads.delete(key));
  pendingReads.set(key, request);
  return request;
}
async function loadPfGet<T>(path: string, options?: { fresh?: boolean }): Promise<T> {
  const { url } = getApiConfig();
  const token = await getToken();
  const res = await reportingFetch(`${url}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    ...(options?.fresh ? { cache: "no-store" as const } : { next: { revalidate: 300 } }), // corrections must be visible immediately
  });
  if (!res.ok) throw new Error(`PF API GET ${path} → ${res.status}`);
  return res.json();
}

export async function pfPost<T>(path: string, body: unknown, options?: { timeoutMs: number; retry: false }): Promise<T> {
  const { url } = getApiConfig();
  const token = await getToken();
  const res = await reportingFetch(`${url}${path}`, {
    ...(options ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`PF API POST ${path} → ${res.status}`);
  return res.json();
}

/** Failed reports reject as a whole; unavailable data must not become zero. */
export async function pfGetAll<T>(paths: string[]): Promise<(T | null)[]> {
  return Promise.all(paths.map(path => pfGet<T>(path)));
}

/** Format a Date as YYYY-MM-DD */
export function fmtDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

/** Monday of the week containing d */
export function weekMonday(d: Date): Date {
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff);
  mon.setHours(0, 0, 0, 0);
  return mon;
}
