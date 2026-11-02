import { createFileRoute } from "@tanstack/react-router";

/**
 * Offline copy only: whether the internet is back and how many offline
 * bookings are still waiting to be sent, for the status shown on every page.
 * Not found anywhere else.
 */
export const Route = createFileRoute("/api/offline-status")({
  server: {
    handlers: {
      GET: async () => {
        const { offlineSyncStatus } = await import("@/lib/offline-sync.server");
        const status = await offlineSyncStatus();
        if (!status.enabled) return new Response("Not found", { status: 404 });
        return Response.json(status, { headers: { "cache-control": "no-store" } });
      },
    },
  },
});
