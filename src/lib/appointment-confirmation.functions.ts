import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { normalizePhilippineMobile, phoneSchema } from "./shop";

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

const serviceProgressSchema = z.object({
  appointmentId: z.string().uuid(),
  action: z.enum(["start", "snooze_arrival", "no_show", "complete", "snooze_completion"]),
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
  products: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(999),
        unitPrice: z.number().finite().min(0).max(9_999_999.99),
      }),
    )
    .max(50)
    .refine(
      (products) => new Set(products.map((product) => product.productId)).size === products.length,
      "Products must be unique.",
    ),
});

type ConfirmationEmailConfig = {
  apiKey: string;
  from: string;
};

type ConfirmationEmailResult = { sent: true } | { sent: false; error: string };

type TextBeeConfig = {
  apiKey: string;
  deviceId?: string;
  simSubscriptionId?: number;
};

const TEXTBEE_DEMO_PHONE = "09242698505";

type ConfirmationSmsResult = {
  sent: boolean;
  skipped: boolean;
  error: string | null;
};

function emailConfig(): ConfirmationEmailConfig | null {
  const apiKey = process.env["RESEND_API_KEY"]?.trim();
  const from = process.env["RESEND_FROM_EMAIL"]?.trim();
  return apiKey && from ? { apiKey, from } : null;
}

function textBeeConfig(): { config: TextBeeConfig } | { error: string } {
  const apiKey = process.env["TEXTBEE_API_KEY"]?.trim();
  if (!apiKey) {
    return {
      error:
        "SMS is not configured. Set TEXTBEE_API_KEY before sending customer notifications.",
    };
  }

  const deviceId = process.env["TEXTBEE_DEVICE_ID"]?.trim() || undefined;
  const rawSimSubscriptionId = process.env["TEXTBEE_SIM_SUBSCRIPTION_ID"]?.trim();
  if (!rawSimSubscriptionId) {
    return { config: deviceId ? { apiKey, deviceId } : { apiKey } };
  }

  const simSubscriptionId = Number(rawSimSubscriptionId);
  if (!Number.isInteger(simSubscriptionId) || simSubscriptionId < 0) {
    return {
      error:
        "SMS is not configured correctly. TEXTBEE_SIM_SUBSCRIPTION_ID must be a non-negative integer.",
    };
  }
  return {
    config: deviceId ? { apiKey, deviceId, simSubscriptionId } : { apiKey, simSubscriptionId },
  };
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

function formatSmsDate(date: string) {
  return new Intl.DateTimeFormat("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Manila",
  }).format(new Date(`${date}T12:00:00+08:00`));
}

function formatPhilippineMobileE164(phone: string) {
  const localNumber = normalizePhilippineMobile(phone);
  return localNumber ? `+63${localNumber.slice(1)}` : null;
}

function isTextBeeDemoPhone(phone: string) {
  return phone.trim() === TEXTBEE_DEMO_PHONE;
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

async function sendQueuedConfirmationEmail(appointmentId: string): Promise<ConfirmationEmailResult> {
  const config = emailConfig();
  if (!config) {
    return {
      sent: false,
      error: "Confirmation email is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL.",
    };
  }

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

async function sendQueuedConfirmationSms(
  appointmentId: string,
): Promise<ConfirmationSmsResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = new Date().toISOString();
  const { data: queuedDelivery, error: pendingError } = await supabaseAdmin
    .from("appointment_confirmation_sms")
    .select("id,attempt_count,recipient_phone,status")
    .eq("appointment_id", appointmentId)
    .maybeSingle();
  if (pendingError) {
    console.error("[Confirmation SMS] queue lookup failed", pendingError);
    return { sent: false, skipped: false, error: "The confirmation SMS could not be queued." };
  }
  if (!queuedDelivery) {
    return { sent: false, skipped: false, error: "The confirmation SMS could not be queued." };
  }
  if (queuedDelivery.status === "sent") return { sent: true, skipped: false, error: null };
  if (queuedDelivery.status === "skipped") return { sent: false, skipped: true, error: null };
  if (queuedDelivery.status !== "pending") {
    return {
      sent: false,
      skipped: false,
      error: "The confirmation SMS is already being sent.",
    };
  }

  const { data: delivery, error: claimError } = await supabaseAdmin
    .from("appointment_confirmation_sms")
    .update({
      status: "sending",
      attempt_count: queuedDelivery.attempt_count + 1,
      last_error: null,
      updated_at: now,
    })
    .eq("id", queuedDelivery.id)
    .eq("status", "pending")
    .select("id,recipient_phone")
    .maybeSingle();
  if (claimError) {
    console.error("[Confirmation SMS] queue claim failed", claimError);
    return { sent: false, skipped: false, error: "The confirmation SMS could not be queued." };
  }
  if (!delivery) return { sent: true, skipped: false, error: null };

  if (!isTextBeeDemoPhone(delivery.recipient_phone)) {
    const { error: skipError } = await supabaseAdmin
      .from("appointment_confirmation_sms")
      .update({
        status: "skipped",
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", delivery.id);
    if (skipError) console.error("[Confirmation SMS] skip-state update failed", skipError);
    return { sent: false, skipped: true, error: null };
  }

  const configured = textBeeConfig();
  if ("error" in configured) {
    await supabaseAdmin
      .from("appointment_confirmation_sms")
      .update({
        status: "pending",
        last_error: configured.error.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("id", delivery.id);
    return { sent: false, skipped: false, error: configured.error };
  }

  try {
    const recipient = formatPhilippineMobileE164(delivery.recipient_phone);
    if (!recipient) throw new Error("The customer's mobile number is invalid.");

    const { data: appointment, error: appointmentError } = await supabaseAdmin
      .from("appointments")
      .select(
        "reference_code,appointment_date,start_time,booking_duration_minutes,total_estimate,rescheduled_from_appointment_id,appointment_services(service_name)",
      )
      .eq("id", appointmentId)
      .eq("status", "confirmed")
      .maybeSingle();
    if (appointmentError || !appointment) {
      throw new Error("The approved appointment details could not be loaded.");
    }

    const services = (appointment.appointment_services ?? [])
      .map((service) => service.service_name)
      .filter(Boolean)
      .join(", ");
    const appointmentKind = appointment.rescheduled_from_appointment_id
      ? "rescheduled appointment"
      : "appointment";
    const message = [
      `Fake Rider: Your ${appointmentKind} is CONFIRMED.`,
      `Ref: ${appointment.reference_code}.`,
      `Date: ${formatSmsDate(appointment.appointment_date)} at ${formatAppointmentTime(appointment.start_time)} (${formatDuration(appointment.booking_duration_minutes)}).`,
      services ? `Services: ${services}.` : "",
      `Estimated total: PHP ${Number(appointment.total_estimate).toFixed(2)}.`,
      "Please keep your reference code for tracking.",
    ]
      .filter(Boolean)
      .join(" ");
    const body: {
      recipients: string[];
      message: string;
      deviceId?: string;
      simSubscriptionId?: number;
    } = {
      recipients: [recipient],
      message,
    };
    if (configured.config.deviceId) body.deviceId = configured.config.deviceId;
    if (configured.config.simSubscriptionId !== undefined) {
      body.simSubscriptionId = configured.config.simSubscriptionId;
    }

    const response = await fetch("https://api.textbee.dev/api/v1/gateway/send-sms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": configured.config.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`TextBee returned ${response.status}.`);
    }

    const { error: sentError } = await supabaseAdmin
      .from("appointment_confirmation_sms")
      .update({
        status: "sent",
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", delivery.id);
    if (sentError) console.error("[Confirmation SMS] sent-state update failed", sentError);
    return { sent: true, skipped: false, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The SMS provider could not be reached.";
    console.error("[Confirmation SMS] send failed", error);
    await supabaseAdmin
      .from("appointment_confirmation_sms")
      .update({
        status: "pending",
        last_error: message.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("id", delivery.id);
    return {
      sent: false,
      skipped: false,
      error: "The appointment was confirmed, but the confirmation SMS could not be sent.",
    };
  }
}

async function sendConfirmationNotifications(appointmentId: string) {
  const [emailResult, smsResult] = await Promise.allSettled([
    sendQueuedConfirmationEmail(appointmentId),
    sendQueuedConfirmationSms(appointmentId),
  ]);
  const emailDelivery: ConfirmationEmailResult =
    emailResult.status === "fulfilled"
      ? emailResult.value
      : (() => {
          console.error("[Confirmation email] unhandled delivery failure", emailResult.reason);
          return {
            sent: false,
            error: "The appointment was confirmed, but the confirmation email could not be sent.",
          };
        })();
  const smsDelivery: ConfirmationSmsResult =
    smsResult.status === "fulfilled"
      ? smsResult.value
      : (() => {
          console.error("[Confirmation SMS] unhandled delivery failure", smsResult.reason);
          return {
            sent: false,
            skipped: false,
            error: "The appointment was confirmed, but the confirmation SMS could not be sent.",
          };
        })();
  return { emailDelivery, smsDelivery };
}

type CompletionDeliveryResult = { sent: true } | { sent: false; error: string };
type CompletionChannel = "email" | "sms";
type CompletionClaim =
  | { kind: "claimed"; id: string; recipient: string }
  | { kind: "sent" }
  | { kind: "skipped" }
  | { kind: "error"; error: string };

function completionChannelLabel(channel: CompletionChannel) {
  return channel === "email" ? "email" : "SMS";
}

async function claimCompletionNotification(
  appointmentId: string,
  channel: CompletionChannel,
): Promise<CompletionClaim> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const label = completionChannelLabel(channel);
  const { data: queuedDelivery, error: pendingError } = await supabaseAdmin
    .from("appointment_completion_notifications")
    .select("id,attempt_count,recipient,status")
    .eq("appointment_id", appointmentId)
    .eq("channel", channel)
    .maybeSingle();
  if (pendingError || !queuedDelivery) {
    if (pendingError) console.error(`[Completion ${label}] queue lookup failed`, pendingError);
    return { kind: "error", error: `The completion ${label} could not be queued.` };
  }
  if (queuedDelivery.status === "sent") return { kind: "sent" };
  if (queuedDelivery.status === "skipped") return { kind: "skipped" };
  if (queuedDelivery.status !== "pending") {
    return { kind: "error", error: `The completion ${label} is already being sent.` };
  }

  const { data: delivery, error: claimError } = await supabaseAdmin
    .from("appointment_completion_notifications")
    .update({
      status: "sending",
      attempt_count: queuedDelivery.attempt_count + 1,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", queuedDelivery.id)
    .eq("status", "pending")
    .select("id,recipient")
    .maybeSingle();
  if (claimError) {
    console.error(`[Completion ${label}] queue claim failed`, claimError);
    return { kind: "error", error: `The completion ${label} could not be queued.` };
  }
  return delivery ? { kind: "claimed", ...delivery } : { kind: "sent" };
}

async function resetCompletionNotification(
  deliveryId: string,
  error: unknown,
  channel: CompletionChannel,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const message = error instanceof Error ? error.message : "The notification provider could not be reached.";
  console.error(`[Completion ${completionChannelLabel(channel)}] send failed`, error);
  await supabaseAdmin
    .from("appointment_completion_notifications")
    .update({
      status: "pending",
      last_error: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("id", deliveryId);
}

async function markCompletionNotificationSent(deliveryId: string, channel: CompletionChannel) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("appointment_completion_notifications")
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", deliveryId);
  if (error) console.error(`[Completion ${completionChannelLabel(channel)}] sent-state update failed`, error);
}

async function markCompletionNotificationSkipped(deliveryId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from("appointment_completion_notifications")
    .update({
      status: "skipped",
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", deliveryId);
  if (error) console.error("[Completion SMS] skip-state update failed", error);
}

async function loadCompletedAppointment(appointmentId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: appointment, error } = await supabaseAdmin
    .from("appointments")
    .select(
      "reference_code,customer_name,appointment_date,service_ended_at,total_estimate,appointment_services(service_name),appointment_products(product_name,quantity,unit_price)",
    )
    .eq("id", appointmentId)
    .eq("status", "completed")
    .maybeSingle();
  if (error || !appointment) {
    throw new Error("The completed appointment details could not be loaded.");
  }

  const services = (appointment.appointment_services ?? [])
    .map((service) => service.service_name)
    .filter(Boolean);
  const productTotal = (appointment.appointment_products ?? []).reduce(
    (total, product) => total + product.quantity * Number(product.unit_price),
    0,
  );
  return {
    ...appointment,
    services,
    finalAmount: Number(appointment.total_estimate) + productTotal,
  };
}

function formatCompletionDate(value: string | null, appointmentDate: string) {
  if (!value) return formatAppointmentDate(appointmentDate);
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "full",
    timeZone: "Asia/Manila",
  }).format(new Date(value));
}

function formatCompletionSmsDate(value: string | null, appointmentDate: string) {
  if (!value) return formatSmsDate(appointmentDate);
  return new Intl.DateTimeFormat("en-PH", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Manila",
  }).format(new Date(value));
}

async function sendQueuedCompletionEmail(appointmentId: string): Promise<CompletionDeliveryResult> {
  const config = emailConfig();
  if (!config) {
    return {
      sent: false,
      error: "Completion email is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL.",
    };
  }
  const claim = await claimCompletionNotification(appointmentId, "email");
  if (claim.kind === "sent") return { sent: true };
  if (claim.kind === "skipped") {
    return { sent: false, error: "The completion email was skipped." };
  }
  if (claim.kind === "error") return { sent: false, error: claim.error };

  try {
    const appointment = await loadCompletedAppointment(appointmentId);
    const completedOn = formatCompletionDate(
      appointment.service_ended_at,
      appointment.appointment_date,
    );
    const serviceList = appointment.services.map((service) => `<li>${escapeHtml(service)}</li>`).join("");
    const text = [
      `Hello ${appointment.customer_name},`,
      "",
      "Your service at Fake Rider Motorparts has been completed.",
      `Reference code: ${appointment.reference_code}`,
      `Completed on: ${completedOn}`,
      `Services: ${appointment.services.join(", ")}`,
      `Final amount: PHP ${appointment.finalAmount.toFixed(2)}`,
      "Thank you for choosing Fake Rider Motorparts.",
    ].join("\n");
    const html = `<p>Hello ${escapeHtml(appointment.customer_name)},</p><p>Your service at Fake Rider Motorparts has been <strong>completed</strong>.</p><p><strong>Reference code:</strong> ${escapeHtml(appointment.reference_code)}<br /><strong>Completed on:</strong> ${escapeHtml(completedOn)}<br /><strong>Final amount:</strong> PHP ${escapeHtml(appointment.finalAmount.toFixed(2))}</p><p><strong>Services:</strong></p><ul>${serviceList}</ul><p>Thank you for choosing Fake Rider Motorparts.</p>`;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `appointment-completion-${claim.id}`,
      },
      body: JSON.stringify({
        from: config.from,
        to: [claim.recipient],
        subject: `Service completed â€” ${appointment.reference_code}`,
        html,
        text,
      }),
    });
    if (!response.ok) throw new Error(`Email provider returned ${response.status}.`);
    await markCompletionNotificationSent(claim.id, "email");
    return { sent: true };
  } catch (error) {
    await resetCompletionNotification(claim.id, error, "email");
    return {
      sent: false,
      error: "The service was completed, but the completion email could not be sent.",
    };
  }
}

async function sendQueuedCompletionSms(appointmentId: string): Promise<ConfirmationSmsResult> {
  const claim = await claimCompletionNotification(appointmentId, "sms");
  if (claim.kind === "sent") return { sent: true, skipped: false, error: null };
  if (claim.kind === "skipped") return { sent: false, skipped: true, error: null };
  if (claim.kind === "error") return { sent: false, skipped: false, error: claim.error };
  if (claim.kind !== "claimed") {
    return { sent: false, skipped: false, error: "The completion SMS could not be queued." };
  }

  if (!isTextBeeDemoPhone(claim.recipient)) {
    await markCompletionNotificationSkipped(claim.id);
    return { sent: false, skipped: true, error: null };
  }

  const configured = textBeeConfig();
  if ("error" in configured) {
    await resetCompletionNotification(claim.id, new Error(configured.error), "sms");
    return { sent: false, skipped: false, error: configured.error };
  }

  try {
    const recipient = formatPhilippineMobileE164(claim.recipient);
    if (!recipient) throw new Error("The customer's mobile number is invalid.");
    const appointment = await loadCompletedAppointment(appointmentId);
    const message = [
      "Fake Rider: Your service is COMPLETED.",
      `Ref: ${appointment.reference_code}.`,
      `Completed: ${formatCompletionSmsDate(appointment.service_ended_at, appointment.appointment_date)}.`,
      appointment.services.length ? `Services: ${appointment.services.join(", ")}.` : "",
      `Final amount: PHP ${appointment.finalAmount.toFixed(2)}.`,
      "Thank you for choosing Fake Rider.",
    ]
      .filter(Boolean)
      .join(" ");
    const body: {
      recipients: string[];
      message: string;
      deviceId?: string;
      simSubscriptionId?: number;
    } = { recipients: [recipient], message };
    if (configured.config.deviceId) body.deviceId = configured.config.deviceId;
    if (configured.config.simSubscriptionId !== undefined) {
      body.simSubscriptionId = configured.config.simSubscriptionId;
    }
    const response = await fetch("https://api.textbee.dev/api/v1/gateway/send-sms", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": configured.config.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`TextBee returned ${response.status}.`);
    await markCompletionNotificationSent(claim.id, "sms");
    return { sent: true, skipped: false, error: null };
  } catch (error) {
    await resetCompletionNotification(claim.id, error, "sms");
    return {
      sent: false,
      skipped: false,
      error: "The service was completed, but the completion SMS could not be sent.",
    };
  }
}

async function sendCompletionNotifications(appointmentId: string) {
  const [emailResult, smsResult] = await Promise.allSettled([
    sendQueuedCompletionEmail(appointmentId),
    sendQueuedCompletionSms(appointmentId),
  ]);
  const emailDelivery: CompletionDeliveryResult =
    emailResult.status === "fulfilled"
      ? emailResult.value
      : {
          sent: false,
          error: "The service was completed, but the completion email could not be sent.",
        };
  const smsDelivery: ConfirmationSmsResult =
    smsResult.status === "fulfilled"
      ? smsResult.value
      : {
          sent: false,
          skipped: false,
          error: "The service was completed, but the completion SMS could not be sent.",
        };
  if (emailResult.status === "rejected") {
    console.error("[Completion email] unhandled delivery failure", emailResult.reason);
  }
  if (smsResult.status === "rejected") {
    console.error("[Completion SMS] unhandled delivery failure", smsResult.reason);
  }
  return { emailDelivery, smsDelivery };
}

export const updateAppointmentServiceProgressWithNotifications = createServerFn({ method: "POST" })
  .validator((input: unknown) => serviceProgressSchema.parse(input))
  .handler(async ({ data }) => {
    const client = authenticatedSupabaseClient();
    const { error } = await client.rpc("manage_appointment_service_progress", {
      p_appointment_id: data.appointmentId,
      p_action: data.action,
    });
    if (error) return { ok: false as const, error: error.message };
    if (data.action !== "complete") return { ok: true as const };

    const { emailDelivery, smsDelivery } = await sendCompletionNotifications(data.appointmentId);
    return {
      ok: true as const,
      emailSent: emailDelivery.sent,
      emailError: emailDelivery.sent ? null : emailDelivery.error,
      smsSent: smsDelivery.sent,
      smsError: smsDelivery.sent ? null : smsDelivery.error,
    };
  });

export const reviewPendingAppointmentWithConfirmation = createServerFn({ method: "POST" })
  .validator((input: unknown) => reviewSchema.parse(input))
  .handler(async ({ data }) => {
    const client = authenticatedSupabaseClient();

    const { error } = await client.rpc("review_pending_appointment", {
      p_appointment_id: data.appointmentId,
      p_decision: data.decision,
    });
    if (error) return { ok: false as const, error: error.message };
    if (data.decision === "rejected") return { ok: true as const, emailSent: false };

    const { emailDelivery, smsDelivery } = await sendConfirmationNotifications(data.appointmentId);
    return {
      ok: true as const,
      emailSent: emailDelivery.sent,
      emailError: emailDelivery.sent ? null : emailDelivery.error,
      smsSent: smsDelivery.sent,
      smsError: smsDelivery.sent ? null : smsDelivery.error,
    };
  });

export const reviewRescheduleRequestWithConfirmation = createServerFn({ method: "POST" })
  .validator((input: unknown) => reviewSchema.parse(input))
  .handler(async ({ data }) => {
    const client = authenticatedSupabaseClient();

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
        smsSent: false,
        smsError: "The reschedule was approved, but its confirmation SMS could not be prepared.",
      };
    }

    const { emailDelivery, smsDelivery } = await sendConfirmationNotifications(replacement.id);
    return {
      ok: true as const,
      emailSent: emailDelivery.sent,
      emailError: emailDelivery.sent ? null : emailDelivery.error,
      smsSent: smsDelivery.sent,
      smsError: smsDelivery.sent ? null : smsDelivery.error,
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
    const isBeingCompleted =
      existingAppointment.status !== "completed" && data.status === "completed";
    const { error } = await client.rpc("update_appointment_financial_details_atomic", {
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
      p_products: data.products.map((product) => ({
        product_id: product.productId,
        quantity: product.quantity,
        unit_price: product.unitPrice,
      })),
    });
    if (error) return { ok: false as const, error: error.message };
    if (!isBeingConfirmed && !isBeingCompleted) return { ok: true as const, emailSent: false };

    const { emailDelivery, smsDelivery } = isBeingCompleted
      ? await sendCompletionNotifications(data.appointmentId)
      : await sendConfirmationNotifications(data.appointmentId);
    return {
      ok: true as const,
      emailSent: emailDelivery.sent,
      emailError: emailDelivery.sent ? null : emailDelivery.error,
      smsSent: smsDelivery.sent,
      smsError: smsDelivery.sent ? null : smsDelivery.error,
    };
  });
