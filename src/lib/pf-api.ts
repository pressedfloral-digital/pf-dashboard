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

async function getToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const { url, email, password } = getApiConfig();

  const res = await fetch(`${url}/Authentication/Login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    cache: 'no-store',
  });
  const json = await res.json();
  const token = json.jwt ?? json.token ?? json.accessToken ?? json.access_token;
  if (!token) throw new Error('PF API login failed');

  // Cache token for 50 minutes
  cachedToken = { token, expiresAt: Date.now() + 50 * 60 * 1000 };
  return token;
}

export async function pfGet<T>(path: string): Promise<T> {
  const { url } = getApiConfig();
  const token = await getToken();
  const res = await fetch(`${url}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    next: { revalidate: 300 }, // 5-min cache
  });
  if (!res.ok) throw new Error(`PF API GET ${path} → ${res.status}`);
  return res.json();
}

export async function pfPost<T>(path: string, body: unknown): Promise<T> {
  const { url } = getApiConfig();
  const token = await getToken();
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`PF API POST ${path} → ${res.status}`);
  return res.json();
}

/** Fetch multiple URLs in parallel (like GAS fetchAll) */
export async function pfGetAll<T>(paths: string[]): Promise<(T | null)[]> {
  const { url } = getApiConfig();
  const token = await getToken();
  return Promise.all(
    paths.map(path =>
      fetch(`${url}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        next: { revalidate: 300 },
      })
        .then(r => r.ok ? r.json() as Promise<T> : null)
        .catch(() => null)
    )
  );
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
