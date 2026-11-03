// Minimal Shopify Admin GraphQL client (server-only). The older cron routes
// use REST; GraphQL is used where its order search can filter by product_id,
// which REST can't.

const SHOPIFY_GRAPHQL_VERSION = '2024-10';

export async function shopifyGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(
      `https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_GRAPHQL_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, variables }),
        cache: 'no-store',
      }
    );
    if (res.status === 429 && attempt === 0) {
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    if (!res.ok) throw new Error(`Shopify GraphQL → ${res.status}: ${await res.text()}`);
    const json = await res.json() as { data?: T; errors?: unknown };
    if (json.errors || !json.data) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors)}`);
    return json.data;
  }
  throw new Error('Shopify GraphQL → still rate-limited after retry');
}

// Order date as the Utah calendar day — a late-evening Mountain order would
// otherwise land on the next day in UTC.
export function utahDate(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver' }).format(new Date(iso));
}
