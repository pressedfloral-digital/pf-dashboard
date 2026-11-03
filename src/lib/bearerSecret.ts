// Shared-secret checks for cron and server-to-server callers. A secret that
// isn't configured never matches: comparing against `Bearer ${undefined}`
// let a request sending the literal "Bearer undefined" straight through.

/** True when `provided` equals a configured, non-empty `secret`. */
export function secretMatches(provided: string | null | undefined, secret: string | undefined): boolean {
  return !!secret && provided === secret;
}

/** True when an Authorization header is `Bearer <secret>` for a configured secret. */
export function hasBearerSecret(authorization: string | null | undefined, secret: string | undefined): boolean {
  return !!secret && authorization === `Bearer ${secret}`;
}
