/**
 * Requests the database sends on a schedule (pg_cron) carry
 * SCHEDULED_NOTIFICATIONS_SECRET as a bearer token. Returns the response to
 * send when the request is not allowed, or null when it is.
 */
export function refuseUnscheduledRequest(request: Request): Response | null {
  const secret = process.env["SCHEDULED_NOTIFICATIONS_SECRET"]?.trim();
  if (!secret) {
    console.error("[Scheduled request] SCHEDULED_NOTIFICATIONS_SECRET is not set");
    return Response.json({ ok: false, error: "Not configured." }, { status: 503 });
  }
  if (!sameSecret(request.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return Response.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }
  return null;
}

/** Compares in constant time, so response timing does not reveal the secret. */
function sameSecret(received: string, expected: string) {
  const a = new TextEncoder().encode(received);
  const b = new TextEncoder().encode(expected);
  let difference = a.length ^ b.length;
  for (let i = 0; i < b.length; i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}
