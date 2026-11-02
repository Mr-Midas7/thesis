/**
 * Alerts for problems a person needs to act on, shown in the admin's
 * notifications like new bookings are.
 */

export type AdminAlert = {
  /** The notification type, e.g. "customer_notice_failed". */
  type: string;
  title: string;
  message: string;
  appointmentId?: string | null;
  /** Skip the alert while an unread one of the same type is this recent. */
  onceWithinMinutes?: number;
};

export async function alertAdmin(alert: AdminAlert) {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (alert.onceWithinMinutes) {
      const since = new Date(Date.now() - alert.onceWithinMinutes * 60_000).toISOString();
      const { data: recent, error } = await supabaseAdmin
        .from("notifications")
        .select("id")
        .eq("type", alert.type)
        .eq("is_read", false)
        .gte("created_at", since)
        .limit(1);
      if (error) throw error;
      if (recent.length) return;
    }
    const { error } = await supabaseAdmin.from("notifications").insert({
      type: alert.type,
      title: alert.title.slice(0, 200),
      message: alert.message.slice(0, 1000),
      appointment_id: alert.appointmentId ?? null,
    });
    if (error) throw error;
  } catch (error) {
    console.error("[Admin alert] could not be saved", { type: alert.type, error });
  }
}

/** Remove email addresses and phone numbers before an error is shown or stored. */
export function redactPersonalDetails(value: string) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/\+?\d[\d\s()-]{7,}\d/g, "[phone]")
    .replace(/\s+/g, " ")
    .trim();
}
