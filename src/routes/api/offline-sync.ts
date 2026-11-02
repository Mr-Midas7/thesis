import { createFileRoute } from "@tanstack/react-router";

/**
 * Offline copy only. Called every minute by the local database
 * (offline/setup.sql) to check the internet and send offline bookings to the
 * live site (src/lib/offline-sync.server.ts). Not found anywhere else.
 */
export const Route = createFileRoute("/api/offline-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { offlineSyncConfig, runOfflineSync } = await import("@/lib/offline-sync.server");
        if (!offlineSyncConfig()) return new Response("Not found", { status: 404 });
        const { refuseUnscheduledRequest } = await import("@/lib/scheduled-request.server");
        const refusal = refuseUnscheduledRequest(request);
        if (refusal) return refusal;
        return Response.json(await runOfflineSync());
      },
    },
  },
});
