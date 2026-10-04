import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { phoneSchema } from "./shop";

const appointmentStatuses = [
  "pending",
  "confirmed",
  "in_progress",
  "completed",
  "rescheduled",
  "cancelled",
  "rejected",
  "no_show",
] as const;

const reviewSchema = z.object({
  appointmentId: z.string().uuid(),
  decision: z.enum(["confirmed", "rejected"]),
});

const appointmentUpdateSchema = z.object({
  appointmentId: z.string().uuid(),
  serviceIds: z.array(z.string().uuid()).min(1),
  appointmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  assignedCrewId: z.string().uuid().nullable(),
  crewAssignmentManual: z.boolean(),
  status: z.enum(appointmentStatuses),
  adminNotes: z.string().max(5_000).nullable(),
  firstName: z.string().trim().min(1).max(40),
  middleName: z.string().trim().max(40),
  lastName: z.string().trim().min(1).max(40),
  phone: phoneSchema,
});

type ConfirmationEmailConfig = {
  apiKey: string;
  from: string;
};

type ConfirmationEmailResult = { sent: true } | { sent: false; error: string };

function emailConfig(): ConfirmationEmailConfig | null {
  const apiKey = process.env["RESEND_API_KEY"]?.trim();
  const from = process.env["RESEND_FROM_EMAIL"]?.trim();
  return apiKey && from ? { apiKey, from } : null;
}

function escapeHtml(value: string | number | null | undefined) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatAppointmentDate(date: string) {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "full",
    timeZone: "Asia/Manila",
  }).format(new Date(`${date}T12:00:00+08:00`));
}

function formatAppointmentTime(time: string) {
  const [hour = "0", minute = "0"] = time.slice(0, 5).split(":");
  const date = new Date(`2000-01-01T${hour.padStart(2, "0")}:${minute}:00+08:00`);
  return new Intl.DateTimeFormat("en-PH", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Manila",
  }).format(date);
}

function formatDuration(durationMinutes: number) {
  const hours = Math.floor(durationMinutes / 60);
  const minutes = durationMinutes % 60;
  return [
    hours ? `${hours} hour${hours === 1 ? "" : "s"}` : "",
    minutes ? `${minutes} minutes` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function authenticatedSupabaseClient() {
  const authorization = getRequest()?.headers.get("authorization");
  const url = process.env["SUPABASE_URL"];
  const key =
    process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];
  if (!authorization?.startsWith("Bearer ") || !url || !key) {
    throw new Error("Your administrator session has expired. Please sign in again.");
  }

  return createClient<Database>(url, key, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function confirmationEmailReadiness(
  client: ReturnType<typeof authenticatedSupabaseClient>,
  appointmentId: string,
) {
  const config = emailConfig();
  if (!config) {
    return {
      ok: false as const,
      error:
        "Confirmation email is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL before approving appointments.",
    };
  }

  const { data: appointment, error } = await client
    .from("appointments")
    .select("email,status")
    .eq("id", appointmentId)
    .maybeSingle();
  if (error || !appointment) {
    return { ok: false as const, error: "This appointment is no longer available." };
  }
  if (!appointment.email) {
    return {
      ok: false as const,
      error: "This appointment has no customer email address and cannot be confirmed online.",
    };
  }
  return { ok: true as const, config, status: appointment.status };
}

async function sendQueuedConfirmationEmail(
  appointmentId: string,
  config: ConfirmationEmailConfig,
): Promise<ConfirmationEmailResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = new Date().toISOString();
  const { data: queuedDelivery, error: pendingError } = await supabaseAdmin
    .from("appointment_confirmation_emails")
    .select("id,attempt_count,recipient_email,status")
    .eq("appointment_id", appointmentId)
    .maybeSingle();
  if (pendingError) {
    console.error("[Confirmation email] queue lookup failed", pendingError);
    return { sent: false, error: "The confirmation email could not be queued." };
  }
  if (!queuedDelivery) {
    return { sent: false, error: "The confirmation email could not be queued." };
  }
  if (queuedDelivery.status === "sent") return { sent: true };
  if (queuedDelivery.status !== "pending") {
    return { sent: false, error: "The confirmation email is already being sent." };
  }

  const { data: delivery, error: claimError } = await supabaseAdmin
    .from("appointment_confirmation_emails")
    .update({
      status: "sending",
      attempt_count: queuedDelivery.attempt_count + 1,
      last_error: null,
      updated_at: now,
    })
    .eq("id", queuedDelivery.id)
    .eq("status", "pending")
    .select("id,recipient_email")
    .maybeSingle();
  if (claimError) {
    console.error("[Confirmation email] queue claim failed", claimError);
    return { sent: false, error: "The confirmation email could not be queued." };
  }
  if (!delivery) return { sent: true };

  try {
    const { data: appointment, error: appointmentError } = await supabaseAdmin
      .from("appointments")
      .select(
        "reference_code,customer_name,appointment_date,start_time,booking_duration_minutes,total_estimate,moto_brand,moto_model,moto_variant,moto_year,plate_number,notes,appointment_services(service_name,duration_minutes),appointment_continuations(segment_number,appointment_date,start_time,booking_duration_minutes)",
      )
      .eq("id", appointmentId)
      .eq("status", "confirmed")
      .maybeSingle();
    if (appointmentError || !appointment) {
      throw new Error("The approved appointment details could not be loaded.");
    }

    const primarySchedule = `${formatAppointmentDate(appointment.appointment_date)} at ${formatAppointmentTime(appointment.start_time)} (${formatDuration(appointment.booking_duration_minutes)})`;
    const continuationSchedules = (appointment.appointment_continuations ?? [])
      .sort((left, right) => left.segment_number - right.segment_number)
      .map(
        (segment) =>
          `${formatAppointmentDate(segment.appointment_date)} at ${formatAppointmentTime(segment.start_time)} (${formatDuration(segment.booking_duration_minutes)})`,
      );
    const services = (appointment.appointment_services ?? []).map(
      (service) => service.service_name,
    );
    const motorcycle = [
      appointment.moto_brand,
      appointment.moto_model,
      appointment.moto_variant,
      appointment.moto_year,
    ]
      .filter(Boolean)
      .join(" ");
    const scheduleRows = [primarySchedule, ...continuationSchedules]
      .map((schedule) => `<li>${escapeHtml(schedule)}</li>`)
      .join("");
    const serviceList = services.map((service) => `<li>${escapeHtml(service)}</li>`).join("");
    const text = [
      `Hello ${appointment.customer_name},`,
      "",
      "Your Fake Rider Motorparts appointment has been approved.",
      `Reference code: ${appointment.reference_code}`,
      `Schedule: ${[primarySchedule, ...continuationSchedules].join("; ")}`,
      `Services: ${services.join(", ")}`,
      `Motorcycle: ${motorcycle}`,
      `Plate number: ${appointment.plate_number}`,
      `Estimated total: PHP ${Number(appointment.total_estimate).toFixed(2)}`,
      appointment.notes ? `Notes: ${appointment.notes}` : "",
      "",
      "Please keep your reference code for appointment tracking.",
    ]
      .filter(Boolean)
      .join("\n");
    const html = `<p>Hello ${escapeHtml(appointment.customer_name)},</p><p>Your Fake Rider Motorparts appointment has been <strong>approved</strong>.</p><p><strong>Reference code:</strong> ${escapeHtml(appointment.reference_code)}</p><p><strong>Confirmed schedule:</strong></p><ul>${scheduleRows}</ul><p><strong>Services:</strong></p><ul>${serviceList}</ul><p><strong>Motorcycle:</strong> ${escapeHtml(motorcycle)}<br /><strong>Plate number:</strong> ${escapeHtml(appointment.plate_number)}<br /><strong>Estimated total:</strong> PHP ${escapeHtml(Number(appointment.total_estimate).toFixed(2))}</p>${appointment.notes ? `<p><strong>Notes:</strong> ${escapeHtml(appointment.notes)}</p>` : ""}<p>Please keep your reference code for appointment tracking.</p>`;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `appointment-confirmation-${delivery.id}`,
      },
      body: JSON.stringify({
        from: config.from,
        to: [delivery.recipient_email],
        subject: `Appointment confirmed — ${appointment.reference_code}`,
        html,
        text,
      }),
    });
    if (!response.ok) {
      throw new Error(`Email provider returned ${response.status}.`);
    }

    const { error: sentError } = await supabaseAdmin
      .from("appointment_confirmation_emails")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", delivery.id);
    if (sentError) console.error("[Confirmation email] sent-state update failed", sentError);
    return { sent: true };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "The email provider could not be reached.";
    console.error("[Confirmation email] send failed", error);
    await supabaseAdmin
      .from("appointment_confirmation_emails")
      .update({
        status: "pending",
        last_error: message.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("id", delivery.id);
    return {
      sent: false,
      error: "The appointment was confirmed, but the confirmation email could not be sent.",
    };
  }
}

export const reviewPendingAppointmentWithConfirmation = createServerFn({ method: "POST" })
  .validator((input: unknown) => reviewSchema.parse(input))
  .handler(async ({ data }) => {
    const client = authenticatedSupabaseClient();
    let config: ConfirmationEmailConfig | null = null;
    if (data.decision === "confirmed") {
      const readiness = await confirmationEmailReadiness(client, data.appointmentId);
      if (!readiness.ok) return readiness;
      config = readiness.config;
    }

    const { error } = await client.rpc("review_pending_appointment", {
      p_appointment_id: data.appointmentId,
      p_decision: data.decision,
    });
    if (error) return { ok: false as const, error: error.message };
    if (data.decision === "rejected") return { ok: true as const, emailSent: false };

    const delivery = await sendQueuedConfirmationEmail(data.appointmentId, config!);
    return {
      ok: true as const,
      emailSent: delivery.sent,
      emailError: delivery.sent ? null : delivery.error,
    };
  });

export const reviewRescheduleRequestWithConfirmation = createServerFn({ method: "POST" })
  .validator((input: unknown) => reviewSchema.parse(input))
  .handler(async ({ data }) => {
    const client = authenticatedSupabaseClient();
    let config: ConfirmationEmailConfig | null = null;
    if (data.decision === "confirmed") {
      const readiness = await confirmationEmailReadiness(client, data.appointmentId);
      if (!readiness.ok) return readiness;
      config = readiness.config;
    }

    const { error } = await client.rpc("review_reschedule_request", {
      p_appointment_id: data.appointmentId,
      p_decision: data.decision,
    });
    if (error) return { ok: false as const, error: error.message };
    if (data.decision === "rejected") return { ok: true as const, emailSent: false };

    const { data: replacement, error: replacementError } = await client
      .from("appointments")
      .select("id")
      .eq("rescheduled_from_appointment_id", data.appointmentId)
      .eq("status", "confirmed")
      .maybeSingle();
    if (replacementError || !replacement) {
      return {
        ok: true as const,
        emailSent: false,
        emailError:
          "The reschedule was approved, but its confirmation email could not be prepared.",
      };
    }

    const delivery = await sendQueuedConfirmationEmail(replacement.id, config!);
    return {
      ok: true as const,
      emailSent: delivery.sent,
      emailError: delivery.sent ? null : delivery.error,
    };
  });

export const updateAppointmentWithConfirmation = createServerFn({ method: "POST" })
  .validator((input: unknown) => appointmentUpdateSchema.parse(input))
  .handler(async ({ data }) => {
    const client = authenticatedSupabaseClient();
    const { data: existingAppointment, error: existingAppointmentError } = await client
      .from("appointments")
      .select("status")
      .eq("id", data.appointmentId)
      .maybeSingle();
    if (existingAppointmentError || !existingAppointment) {
      return { ok: false as const, error: "This appointment is no longer available." };
    }

    const isBeingConfirmed =
      existingAppointment.status !== "confirmed" && data.status === "confirmed";
    let config: ConfirmationEmailConfig | null = null;
    if (isBeingConfirmed) {
      const readiness = await confirmationEmailReadiness(client, data.appointmentId);
      if (!readiness.ok) return readiness;
      config = readiness.config;
    }

    const { error } = await client.rpc("update_appointment_details_atomic", {
      p_appointment_id: data.appointmentId,
      p_service_ids: data.serviceIds,
      p_appointment_date: data.appointmentDate,
      p_start_time: data.startTime,
      p_assigned_crew_id: data.assignedCrewId,
      p_crew_assignment_manual: data.crewAssignmentManual,
      p_status: data.status,
      p_admin_notes: data.adminNotes,
      p_first_name: data.firstName,
      p_middle_name: data.middleName,
      p_last_name: data.lastName,
      p_phone: data.phone,
    });
    if (error) return { ok: false as const, error: error.message };
    if (!isBeingConfirmed) return { ok: true as const, emailSent: false };

    const delivery = await sendQueuedConfirmationEmail(data.appointmentId, config!);
    return {
      ok: true as const,
      emailSent: delivery.sent,
      emailError: delivery.sent ? null : delivery.error,
    };
  });
