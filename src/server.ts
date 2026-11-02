import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(
  request: Request,
  response: Response,
): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  const error = consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`);
  console.error(error);
  await alertPageFailure(request, error);
  return new Response(renderErrorPage(), {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Tells the admin that a visitor got the error page, at most once an hour while
 * the alert is unread. Waits at most 2 seconds so the visitor is not kept waiting.
 */
async function alertPageFailure(request: Request, error: unknown) {
  try {
    const { alertAdmin, redactPersonalDetails } = await import("./lib/admin-alerts.server");
    // The path only: query strings can hold reference codes and phone numbers.
    const path = new URL(request.url).pathname;
    const detail = error instanceof Error ? redactPersonalDetails(error.message).slice(0, 300) : "";
    await Promise.race([
      alertAdmin({
        type: "server_error",
        title: "A page failed to load",
        message: `A visitor got the error page at ${path}${detail ? `. Server error: ${detail}` : "."}`,
        onceWithinMinutes: 60,
      }),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  } catch (alertError) {
    console.error("[Admin alert] page failure alert failed", alertError);
  }
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return await normalizeCatastrophicSsrResponse(request, response);
    } catch (error) {
      console.error(error);
      await alertPageFailure(request, error);
      return new Response(renderErrorPage(), {
        status: 500,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
  },
};
