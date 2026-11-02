/**
 * Offline copy only: sends bookings made offline to the live site once the
 * internet is back.
 *
 * Every minute the local database (offline/setup.sql) calls /api/offline-sync,
 * which checks whether the live database can be reached. If it can, each
 * booking made in the offline copy is created on the live site with the same
 * reference code, oldest first. A booking that no longer fits there (the time
 * was taken online meanwhile, for example) is reported to the admin to call the
 * customer. Off unless OFFLINE_SYNC_TO_LIVE=1 in .env.offline.
 */
import { createClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

import { formatAppointmentTime, formatSmsDate } from "./customer-emails";

type SyncConfig = {
  liveUrl: string;
  liveKey: string;
  /** When the live data was copied: bookings created after it were made offline. */
  copiedAt: Date;
  /** The live website, where people are sent once the internet is back. */
  liveSiteUrl: string | null;
};

export function offlineSyncConfig(): SyncConfig | null {
  if (process.env["OFFLINE_SYNC_TO_LIVE"]?.trim() !== "1") return null;
  const liveUrl = process.env["LIVE_SUPABASE_URL"]?.trim().replace(/\/+$/, "");
  const liveKey = process.env["LIVE_SUPABASE_SERVICE_ROLE_KEY"]?.trim();
  const copiedAt = new Date(process.env["OFFLINE_COPY_TAKEN_AT"]?.trim() ?? "");
  const localUrl = process.env["SUPABASE_URL"]?.trim().replace(/\/+$/, "");
  // Uploading to the offline copy's own database would duplicate every booking.
  if (!liveUrl || !liveKey || Number.isNaN(copiedAt.getTime()) || liveUrl === localUrl) {
    return null;
  }
  const site = process.env["LIVE_SITE_URL"]?.trim().replace(/\/+$/, "");
  return {
    liveUrl,
    liveKey,
    copiedAt,
    liveSiteUrl: site && /^https?:\/\//.test(site) ? site : null,
  };
}

/** The offline copy's own tables for this, which the live site does not have. */
function localSyncTables() {
  return createClient(
    process.env["SUPABASE_URL"] ?? "",
    process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "",
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

function liveClient(config: SyncConfig) {
  return createClient<Database>(config.liveUrl, config.liveKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function liveIsReachable(config: SyncConfig) {
  try {
    const response = await fetch(`${config.liveUrl}/auth/v1/health`, {
      headers: { apikey: config.liveKey },
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const OFFLINE_BOOKING_FIELDS =
  "id,reference_code,booking_request_id,customer_name,first_name,middle_name,last_name,phone,email,moto_brand,moto_model,moto_variant,moto_year,plate_number,appointment_date,start_time,notes,wants_products,total_estimate,booking_duration_minutes,assigned_crew_id,status,rescheduled_from_appointment_id,appointment_services(service_id,service_name,price,duration_minutes),appointment_continuations(segment_number,appointment_date,start_time,booking_duration_minutes,assigned_crew_id)";

async function loadOfflineBookings(config: SyncConfig) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [bookings, handled] = await Promise.all([
    supabaseAdmin
      .from("appointments")
      .select(OFFLINE_BOOKING_FIELDS)
      .gte("created_at", config.copiedAt.toISOString())
      .in("status", ["pending", "confirmed"])
      .eq("is_archived", false)
      .order("created_at"),
    localSyncTables().from("offline_booking_uploads").select("appointment_id"),
  ]);
  if (bookings.error)
    throw new Error(`Offline bookings could not be read: ${bookings.error.message}`);
  if (handled.error) throw new Error(`Upload records could not be read: ${handled.error.message}`);
  const done = new Set(
    ((handled.data ?? []) as { appointment_id: string }[]).map((row) => row.appointment_id),
  );
  // Bookings whose time has passed are left alone: there is nothing to keep for them.
  return (bookings.data ?? []).filter(
    (booking) =>
      !done.has(booking.id) &&
      Date.parse(`${booking.appointment_date}T${booking.start_time.slice(0, 5)}:00+08:00`) >
        Date.now(),
  );
}

type OfflineBooking = Awaited<ReturnType<typeof loadOfflineBookings>>[number];

/** Why the live site refused a booking, in words for the admin. */
function refusalReason(error: { code?: string; message: string }) {
  if (error.code === "23P01") return "That time is no longer free on the live schedule.";
  if (error.code === "23503") return "Its later days no longer fit on the live schedule.";
  if (error.code === "23514" && /upcoming/i.test(error.message)) {
    return "The customer already has the most upcoming bookings allowed on the live site.";
  }
  if (error.code === "23505" && /already (?:have|has) an appointment/i.test(error.message)) {
    return "The customer already has an active booking for the same service on the live site.";
  }
  if (error.code === "23505") return "Its reference code is already used on the live site.";
  return `The live site refused it: ${error.message.slice(0, 200)}`;
}

type UploadResult = { ok: true; liveAppointmentId: string } | { ok: false; reason: string };

async function uploadBooking(
  live: ReturnType<typeof liveClient>,
  booking: OfflineBooking,
  crewIds: string[],
): Promise<UploadResult> {
  if (booking.rescheduled_from_appointment_id) {
    return {
      ok: false,
      reason:
        "It replaced another booking through a reschedule made offline, so it has to be updated on the live site by hand.",
    };
  }
  const services = booking.appointment_services ?? [];
  const requestId = booking.booking_request_id ?? booking.id;
  const input = {
    p_reference_code: booking.reference_code,
    p_booking_request_id: requestId,
    p_customer_name: booking.customer_name,
    p_phone: booking.phone,
    p_email: booking.email ?? "",
    p_moto_brand: booking.moto_brand,
    p_moto_model: booking.moto_model,
    p_moto_variant: booking.moto_variant,
    p_moto_year: booking.moto_year ?? new Date().getFullYear(),
    p_plate_number: booking.plate_number,
    p_appointment_date: booking.appointment_date,
    p_start_time: booking.start_time,
    p_notes: booking.notes,
    p_wants_products: booking.wants_products,
    p_total_estimate: Number(booking.total_estimate),
    p_booking_duration_minutes: booking.booking_duration_minutes,
    p_services: services.map((service) => ({
      service_id: service.service_id,
      service_name: service.service_name,
      price: service.price,
      duration_minutes: service.duration_minutes,
    })),
    p_continuation_segments: [...(booking.appointment_continuations ?? [])]
      .sort((a, b) => a.segment_number - b.segment_number)
      .map((segment) => ({
        segment_number: segment.segment_number,
        appointment_date: segment.appointment_date,
        start_time: segment.start_time,
        booking_duration_minutes: segment.booking_duration_minutes,
        assigned_crew_id: segment.assigned_crew_id,
      })),
    p_notification_title: `New booking ${booking.reference_code} (made offline)`,
    p_notification_message: `${booking.customer_name} booked ${services.map((service) => service.service_name).join(", ")} on ${booking.appointment_date} while the shop was offline. It was added when the internet came back.`,
    p_first_name: booking.first_name ?? "",
    p_middle_name: booking.middle_name ?? "",
    p_last_name: booking.last_name ?? "",
  };

  // The mechanic chosen offline may be busy on the live schedule; another one
  // who is free at that time can take the booking instead.
  const crewOrder: (string | null)[] = [
    ...new Set([booking.assigned_crew_id, ...crewIds].filter((id): id is string => Boolean(id))),
  ];
  if (!crewOrder.length) crewOrder.push(null);
  let refusal: { code?: string; message: string } | null = null;
  for (const crewId of crewOrder) {
    const { error } = await live.rpc("create_booking_atomic", {
      ...input,
      p_assigned_crew_id: crewId,
    });
    if (!error) {
      refusal = null;
      break;
    }
    refusal = error;
    if (error.code !== "23P01") break;
  }
  if (refusal) return { ok: false, reason: refusalReason(refusal) };

  const saved = await live
    .from("appointments")
    .select("id")
    .eq("booking_request_id", requestId)
    .maybeSingle();
  if (saved.error || !saved.data) {
    throw new Error("The booking was sent, but the live site did not return it.");
  }
  return { ok: true, liveAppointmentId: saved.data.id };
}

/**
 * Keeps a booking confirmed offline confirmed on the live site. The live site
 * then emails the confirmation (offline emails only reached the test inbox),
 * but does not repeat a confirmation text the phone already sent.
 */
async function carryOverConfirmation(
  live: ReturnType<typeof liveClient>,
  booking: OfflineBooking,
  liveAppointmentId: string,
) {
  if (booking.status !== "confirmed") return;
  const { error } = await live
    .from("appointments")
    .update({ status: "confirmed" })
    .eq("id", liveAppointmentId)
    .eq("status", "pending");
  if (error)
    throw new Error(`The booking could not be confirmed on the live site: ${error.message}`);

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const text = await supabaseAdmin
    .from("appointment_confirmation_sms")
    .select("status")
    .eq("appointment_id", booking.id)
    .maybeSingle();
  if (text.data?.status === "sent") {
    await live
      .from("appointment_confirmation_sms")
      .update({
        status: "skipped",
        last_error: "Not sent: the customer was texted when it was confirmed offline.",
        updated_at: new Date().toISOString(),
      })
      .eq("appointment_id", liveAppointmentId)
      .eq("status", "pending");
  }
}

async function reportConflict(
  live: ReturnType<typeof liveClient>,
  booking: OfflineBooking,
  reason: string,
) {
  const services = (booking.appointment_services ?? []).map((service) => service.service_name);
  const alert = {
    type: "offline_booking_conflict",
    title: `Call ${booking.customer_name}: offline booking ${booking.reference_code} was not added`,
    message: `${booking.customer_name} booked ${services.join(", ") || "a service"} for ${formatSmsDate(booking.appointment_date)} at ${formatAppointmentTime(booking.start_time)} while the shop was offline (reference ${booking.reference_code}). ${reason} Please call them at ${booking.phone} to arrange another time.`,
  };
  // The live admin sees it once people move there; the offline admin sees it too.
  const { error } = await live.from("notifications").insert(alert);
  if (error) throw new Error(`The live admin could not be told: ${error.message}`);
  const { alertAdmin } = await import("./admin-alerts.server");
  await alertAdmin({ ...alert, appointmentId: booking.id });
}

/** Checks the connection and, when the live site can be reached, uploads offline bookings. */
export async function runOfflineSync() {
  const config = offlineSyncConfig();
  if (!config) return { enabled: false as const };
  const tables = localSyncTables();
  const previous = await tables
    .from("offline_sync_status")
    .select("online,online_since")
    .eq("id", true)
    .maybeSingle();

  const online = await liveIsReachable(config);
  let uploaded = 0;
  let conflicts = 0;
  let lastError: string | null = null;
  let waiting: OfflineBooking[] = [];
  try {
    waiting = await loadOfflineBookings(config);
    if (online && waiting.length) {
      const live = liveClient(config);
      const crew = await live
        .from("crew_members")
        .select("id")
        .eq("is_active", true)
        .eq("is_archived", false);
      if (crew.error) throw new Error(`The live crew could not be read: ${crew.error.message}`);
      const crewIds = crew.data.map((member) => member.id);

      for (const booking of waiting.slice(0, 20)) {
        const result = await uploadBooking(live, booking, crewIds);
        if (result.ok) {
          await carryOverConfirmation(live, booking, result.liveAppointmentId);
          uploaded += 1;
        } else {
          await reportConflict(live, booking, result.reason);
          conflicts += 1;
        }
        const { error } = await tables.from("offline_booking_uploads").insert({
          appointment_id: booking.id,
          status: result.ok ? "uploaded" : "conflict",
          live_appointment_id: result.ok ? result.liveAppointmentId : null,
          detail: result.ok ? null : result.reason,
        });
        if (error) throw new Error(`The upload could not be recorded: ${error.message}`);
      }
      waiting = await loadOfflineBookings(config);
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : "The offline sync failed.";
    console.error("[Offline sync] failed", error);
  }

  const now = new Date().toISOString();
  const wasOnline = previous.data?.online === true;
  await tables.from("offline_sync_status").upsert({
    id: true,
    online,
    checked_at: now,
    online_since: online ? (wasOnline ? (previous.data?.online_since ?? now) : now) : null,
    waiting: waiting.length,
    last_error: lastError?.slice(0, 500) ?? null,
  });
  return {
    enabled: true as const,
    online,
    waiting: waiting.length,
    uploaded,
    conflicts,
    lastError,
  };
}

/** What browsers need to know, without any booking details. */
export async function offlineSyncStatus() {
  const config = offlineSyncConfig();
  if (!config) return { enabled: false as const };
  const { data } = await localSyncTables()
    .from("offline_sync_status")
    .select("online,waiting,checked_at")
    .eq("id", true)
    .maybeSingle();
  const status = data as { online: boolean; waiting: number; checked_at: string | null } | null;
  // A check older than 3 minutes means the sync is not running; treat it as offline.
  const fresh =
    Boolean(status?.checked_at) && Date.parse(status!.checked_at!) > Date.now() - 3 * 60_000;
  return {
    enabled: true as const,
    online: Boolean(fresh && status?.online),
    waiting: status?.waiting ?? 0,
    liveSiteUrl: config.liveSiteUrl,
  };
}
