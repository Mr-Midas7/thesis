import { createFileRoute } from "@tanstack/react-router";

/**
 * Called every 5 minutes by the database (pg_cron, see migration
 * 20261026110000) to send appointment reminders and retry failed customer
 * messages. Only requests carrying SCHEDULED_NOTIFICATIONS_SECRET are accepted.
 */
export const Route = createFileRoute("/api/scheduled-notifications")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { refuseUnscheduledRequest } = await import("@/lib/scheduled-request.server");
        const refusal = refuseUnscheduledRequest(request);
        if (refusal) return refusal;

        // Reminder emails link to My Appointment only on the real (https) site.
        const origin = new URL(request.url).origin;
        const { runScheduledNotifications } =
          await import("@/lib/appointment-confirmation.functions");
        try {
          const result = await runScheduledNotifications(
            origin.startsWith("https://") ? origin : null,
          );
          return Response.json({ ok: true, ...result });
        } catch {
          return Response.json({ ok: false, error: "The scheduled run failed." }, { status: 500 });
        }
      },
    },
  },
});
