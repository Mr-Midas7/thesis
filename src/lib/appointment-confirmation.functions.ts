import { createClient } from "@supabase/supabase-js";
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import {
  appointmentReminderEmail,
  appointmentReminderSms,
  bookingNotAcceptedEmail,
  bookingNotAcceptedSms,
  escapeHtml,
  formatAppointmentDate,
  formatAppointmentTime,
  formatSmsDate,
  rescheduleNotApprovedEmail,
  rescheduleNotApprovedSms,
  type AppointmentSummary,
  type EmailContent,
  type ShopContact,
} from "./customer-emails";
import { SHOP, normalizePhilippineMobile, phoneSchema } from "./shop";

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

type ConfirmationEmailResult = { sent: true } | { sent: false; error: string | null };

type TextBeeConfig = {
  apiKey: string;
  deviceId?: string;
  simSubscriptionId?: number;
};

const DELIVERY_LEASE_MS = 5 * 60 * 1000;

type ConfirmationSmsResult = {
  sent: boolean;
  skipped: boolean;
  error: string | null;
};

/** An Android phone running SMS Gateway for Android in Local Server mode. */
type PhoneGatewayConfig = {
  url: string;
  username: string;
  password: string;
  /** Bookings created before this were copied from the live site and are never texted. */
  bookingsFrom: Date;
};

type SmsConfig =
  ({ provider: "phone" } & PhoneGatewayConfig) | ({ provider: "textbee" } & TextBeeConfig);

const COPIED_BOOKING_NOT_TEXTED =
  "No text was sent: this booking was copied from the live site, so the offline copy does not text its customer.";

/**
 * SMS_GATEWAY_URL (the offline copy) sends through a phone on the local network,
 * which needs no internet. Otherwise TextBee is used.
 */
function smsConfig(): { config: SmsConfig } | { error: string } {
  const gatewayUrl = process.env["SMS_GATEWAY_URL"]?.trim().replace(/\/+$/, "");
  if (!gatewayUrl) {
    const textBee = textBeeConfig();
    return "error" in textBee ? textBee : { config: { provider: "textbee", ...textBee.config } };
  }

  const username = process.env["SMS_GATEWAY_USERNAME"]?.trim() ?? "";
  const password = process.env["SMS_GATEWAY_PASSWORD"]?.trim() ?? "";
  const bookingsFrom = new Date(process.env["OFFLINE_COPY_TAKEN_AT"]?.trim() ?? "");
  let validUrl = false;
  try {
    validUrl = ["http:", "https:"].includes(new URL(gatewayUrl).protocol);
  } catch {
    validUrl = false;
  }
  if (!validUrl || !username || !password || Number.isNaN(bookingsFrom.getTime())) {
    return {
      error:
        "SMS is not configured correctly. Set SMS_GATEWAY_URL, SMS_GATEWAY_USERNAME, SMS_GATEWAY_PASSWORD and OFFLINE_COPY_TAKEN_AT.",
    };
  }
  return {
    config: { provider: "phone", url: gatewayUrl, username, password, bookingsFrom },
  };
}

function textBeeConfig(): { config: TextBeeConfig } | { error: string } {
  const apiKey = process.env["TEXTBEE_API_KEY"]?.trim();
  if (!apiKey) {
    return {
      error: "SMS is not configured. Set TEXTBEE_API_KEY before sending customer notifications.",
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

function formatPhilippineMobileE164(phone: string) {
  const localNumber = normalizePhilippineMobile(phone);
  return localNumber ? `+63${localNumber.slice(1)}` : null;
}

function deliveryLeaseExpired(updatedAt: string | null | undefined) {
  if (!updatedAt) return true;
  const updatedAtMs = new Date(updatedAt).getTime();
  return !Number.isFinite(updatedAtMs) || updatedAtMs <= Date.now() - DELIVERY_LEASE_MS;
}

function redactProviderDetail(value: string) {
  return value
    .replace(/\b(?:re|txb)_[A-Za-z0-9_-]+\b/g, "[redacted-api-key]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\+?\d[\d\s()-]{7,}\d/g, "[redacted-phone]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

/** Sends one text message through TextBee; throws when TextBee does not accept it. */
async function sendTextBeeSms(config: TextBeeConfig, recipient: string, message: string) {
  const body: {
    recipients: string[];
    message: string;
    deviceId?: string;
    simSubscriptionId?: number;
  } = {
    recipients: [recipient],
    message,
  };
  if (config.deviceId) body.deviceId = config.deviceId;
  if (config.simSubscriptionId !== undefined) body.simSubscriptionId = config.simSubscriptionId;

  const response = await fetch("https://api.textbee.dev/api/v1/gateway/send-sms", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.apiKey,
    },
    body: JSON.stringify(body),
  });
  await assertTextBeeAccepted(response);
}

async function assertTextBeeAccepted(response: Response) {
  const body = await response.text();
  if (!response.ok) {
    const detail = redactProviderDetail(body);
    console.error("[TextBee] provider rejected notification", {
      status: response.status,
      detail: detail || undefined,
    });
    throw new Error(`TextBee returned ${response.status}${detail ? `: ${detail}` : "."}`);
  }

  if (!body) return;
  try {
    const payload = JSON.parse(body) as {
      data?: { success?: boolean; successCount?: number; failureCount?: number };
    };
    const delivery = payload.data;
    if (
      delivery?.success === false ||
      (typeof delivery?.failureCount === "number" && delivery.failureCount > 0) ||
      (typeof delivery?.successCount === "number" && delivery.successCount < 1)
    ) {
      console.error("[TextBee] notification was not accepted", {
        success: delivery?.success,
        successCount: delivery?.successCount,
        failureCount: delivery?.failureCount,
      });
      throw new Error("TextBee did not accept the SMS for delivery.");
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      console.warn("[TextBee] provider returned a non-JSON success response");
      return;
    }
    throw error;
  }
}

/** Sends one text message through the phone gateway; throws when the phone does not accept it. */
async function sendPhoneGatewaySms(config: PhoneGatewayConfig, recipient: string, message: string) {
  let response: Response;
  try {
    response = await fetch(`${config.url}/message`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`${config.username}:${config.password}`)}`,
      },
      body: JSON.stringify({ textMessage: { text: message }, phoneNumbers: [recipient] }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.error("[SMS phone] the phone could not be reached", error);
    throw new Error(
      "The SMS phone could not be reached. Check that it is on the same hotspot and its Local Server is online.",
    );
  }

  const body = await response.text();
  if (!response.ok) {
    const detail = redactProviderDetail(body);
    console.error("[SMS phone] the phone rejected the message", {
      status: response.status,
      detail: detail || undefined,
    });
    throw new Error(
      response.status === 401
        ? "The SMS phone rejected the username or password."
        : `The SMS phone returned ${response.status}${detail ? `: ${detail}` : "."}`,
    );
  }
  try {
    const payload = JSON.parse(body) as { state?: string };
    if (payload.state === "Failed") throw new Error("The SMS phone could not send the text.");
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

function sendSms(config: SmsConfig, recipient: string, message: string) {
  return config.provider === "phone"
    ? sendPhoneGatewaySms(config, recipient, message)
    : sendTextBeeSms(config, recipient, message);
}

/**
 * The offline copy texts only bookings made in it. Customers copied from the
 * live site are real people, so their bookings are never texted from it.
 */
async function isCopiedBooking(config: SmsConfig, appointmentId: string) {
  if (config.provider !== "phone") return false;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("appointments")
    .select("created_at")
    .eq("id", appointmentId)
    .maybeSingle();
  if (error || !data) throw new Error("The booking could not be checked before texting.");
  return new Date(data.created_at) < config.bookingsFrom;
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

async function sendQueuedConfirmationEmail(
  appointmentId: string,
): Promise<ConfirmationEmailResult> {
  const { emailTransport, sendEmail } = await import("./email.server");
  const configured = emailTransport();
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  if ("error" in configured) {
    console.error("[Confirmation email] configuration unavailable", { reason: configured.error });
    const { error } = await supabaseAdmin
      .from("appointment_confirmation_emails")
      .update({
        last_error: configured.error.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("appointment_id", appointmentId)
      .eq("status", "pending");
    if (error) console.error("[Confirmation email] configuration-state update failed", error);
    return {
      sent: false,
      error: configured.error,
    };
  }

  const now = new Date().toISOString();
  const { data: queuedDelivery, error: pendingError } = await supabaseAdmin
    .from("appointment_confirmation_emails")
    .select("id,attempt_count,recipient_email,status,updated_at")
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
  const retryingStaleClaim =
    queuedDelivery.status === "sending" && deliveryLeaseExpired(queuedDelivery.updated_at);
  if (queuedDelivery.status !== "pending" && !retryingStaleClaim) {
    console.info("[Confirmation email] delivery is already in progress", { appointmentId });
    return { sent: false, error: null };
  }
  if (retryingStaleClaim)
    console.warn("[Confirmation email] retrying stale delivery lease", { appointmentId });

  let claimQuery = supabaseAdmin
    .from("appointment_confirmation_emails")
    .update({
      status: "sending",
      attempt_count: queuedDelivery.attempt_count + 1,
      last_error: null,
      updated_at: now,
    })
    .eq("id", queuedDelivery.id);
  claimQuery = retryingStaleClaim
    ? claimQuery
        .eq("status", "sending")
        .lte("updated_at", new Date(Date.now() - DELIVERY_LEASE_MS).toISOString())
    : claimQuery.eq("status", "pending");
  const { data: delivery, error: claimError } = await claimQuery
    .select("id,recipient_email")
    .maybeSingle();
  if (claimError) {
    console.error("[Confirmation email] queue claim failed", claimError);
    return { sent: false, error: "The confirmation email could not be queued." };
  }
  if (!delivery) {
    console.info("[Confirmation email] delivery claim lost to another request", { appointmentId });
    return { sent: false, error: null };
  }

  try {
    const { data: appointment, error: appointmentError } = await supabaseAdmin
      .from("appointments")
      .select(
        "reference_code,customer_name,appointment_date,start_time,booking_duration_minutes,total_estimate,moto_brand,moto_model,moto_variant,moto_year,plate_number,notes,appointment_services(service_name,duration_minutes),appointment_continuations(segment_number,appointment_date,start_time,booking_duration_minutes)",
      )
      .eq("id", appointmentId)
      .in("status", ["confirmed", "in_progress", "completed"])
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

    await sendEmail(configured.transport, {
      to: delivery.recipient_email,
      subject: `Appointment confirmed - ${appointment.reference_code}`,
      html,
      text,
      idempotencyKey: `appointment-confirmation-${delivery.id}`,
    });

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

async function sendQueuedConfirmationSms(appointmentId: string): Promise<ConfirmationSmsResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const now = new Date().toISOString();
  const { data: queuedDelivery, error: pendingError } = await supabaseAdmin
    .from("appointment_confirmation_sms")
    .select("id,attempt_count,recipient_phone,status,updated_at")
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
  const retryingStaleClaim =
    queuedDelivery.status === "sending" && deliveryLeaseExpired(queuedDelivery.updated_at);
  if (queuedDelivery.status !== "pending" && !retryingStaleClaim) {
    console.info("[Confirmation SMS] delivery is already in progress", { appointmentId });
    return { sent: false, skipped: false, error: null };
  }
  if (retryingStaleClaim)
    console.warn("[Confirmation SMS] retrying stale delivery lease", { appointmentId });

  let claimQuery = supabaseAdmin
    .from("appointment_confirmation_sms")
    .update({
      status: "sending",
      attempt_count: queuedDelivery.attempt_count + 1,
      last_error: null,
      updated_at: now,
    })
    .eq("id", queuedDelivery.id);
  claimQuery = retryingStaleClaim
    ? claimQuery
        .eq("status", "sending")
        .lte("updated_at", new Date(Date.now() - DELIVERY_LEASE_MS).toISOString())
    : claimQuery.eq("status", "pending");
  const { data: delivery, error: claimError } = await claimQuery
    .select("id,recipient_phone")
    .maybeSingle();
  if (claimError) {
    console.error("[Confirmation SMS] queue claim failed", claimError);
    return { sent: false, skipped: false, error: "The confirmation SMS could not be queued." };
  }
  if (!delivery) {
    console.info("[Confirmation SMS] delivery claim lost to another request", { appointmentId });
    return { sent: false, skipped: false, error: null };
  }

  const configured = smsConfig();
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
    if (await isCopiedBooking(configured.config, appointmentId)) {
      await supabaseAdmin
        .from("appointment_confirmation_sms")
        .update({
          status: "skipped",
          last_error: COPIED_BOOKING_NOT_TEXTED,
          updated_at: new Date().toISOString(),
        })
        .eq("id", delivery.id);
      return { sent: false, skipped: true, error: COPIED_BOOKING_NOT_TEXTED };
    }
    const recipient = formatPhilippineMobileE164(delivery.recipient_phone);
    if (!recipient) throw new Error("The customer's mobile number is invalid.");

    const { data: appointment, error: appointmentError } = await supabaseAdmin
      .from("appointments")
      .select(
        "reference_code,appointment_date,start_time,booking_duration_minutes,total_estimate,rescheduled_from_appointment_id,appointment_services(service_name)",
      )
      .eq("id", appointmentId)
      .in("status", ["confirmed", "in_progress", "completed"])
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
    await sendSms(configured.config, recipient, message);

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
    const message =
      error instanceof Error ? error.message : "The SMS provider could not be reached.";
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

type CompletionDeliveryResult = { sent: true } | { sent: false; error: string | null };
type DeliveryChannel = "email" | "sms";
/** Queues with one row per appointment and channel. */
type ChannelQueue = "appointment_completion_notifications" | "appointment_reminders";
type ChannelClaim =
  | { kind: "claimed"; id: string; recipient: string }
  | { kind: "sent" }
  | { kind: "skipped" }
  | { kind: "in_progress" }
  | { kind: "error"; error: string };

/** "completion email", "reminder SMS" and so on, for messages and logs. */
function channelDeliveryLabel(queue: ChannelQueue, channel: DeliveryChannel) {
  const kind = queue === "appointment_reminders" ? "reminder" : "completion";
  return `${kind} ${channel === "email" ? "email" : "SMS"}`;
}

function channelLogPrefix(queue: ChannelQueue, channel: DeliveryChannel) {
  const label = channelDeliveryLabel(queue, channel);
  return `[${label.charAt(0).toUpperCase()}${label.slice(1)}]`;
}

async function claimChannelDelivery(
  queue: ChannelQueue,
  appointmentId: string,
  channel: DeliveryChannel,
): Promise<ChannelClaim> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const label = channelDeliveryLabel(queue, channel);
  const log = channelLogPrefix(queue, channel);
  const { data: queuedDelivery, error: pendingError } = await supabaseAdmin
    .from(queue)
    .select("id,attempt_count,recipient,status,updated_at")
    .eq("appointment_id", appointmentId)
    .eq("channel", channel)
    .maybeSingle();
  if (pendingError || !queuedDelivery) {
    if (pendingError) console.error(`${log} queue lookup failed`, pendingError);
    return { kind: "error", error: `The ${label} could not be queued.` };
  }
  if (queuedDelivery.status === "sent") return { kind: "sent" };
  if (queuedDelivery.status === "skipped") return { kind: "skipped" };
  const retryingStaleClaim =
    queuedDelivery.status === "sending" && deliveryLeaseExpired(queuedDelivery.updated_at);
  if (queuedDelivery.status !== "pending" && !retryingStaleClaim) {
    console.info(`${log} delivery is already in progress`, { appointmentId });
    return { kind: "in_progress" };
  }
  if (retryingStaleClaim) {
    console.warn(`${log} retrying stale delivery lease`, { appointmentId });
  }

  let claimQuery = supabaseAdmin
    .from(queue)
    .update({
      status: "sending",
      attempt_count: queuedDelivery.attempt_count + 1,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", queuedDelivery.id);
  claimQuery = retryingStaleClaim
    ? claimQuery
        .eq("status", "sending")
        .lte("updated_at", new Date(Date.now() - DELIVERY_LEASE_MS).toISOString())
    : claimQuery.eq("status", "pending");
  const { data: delivery, error: claimError } = await claimQuery
    .select("id,recipient")
    .maybeSingle();
  if (claimError) {
    console.error(`${log} queue claim failed`, claimError);
    return { kind: "error", error: `The ${label} could not be queued.` };
  }
  if (!delivery) {
    console.info(`${log} delivery claim lost to another request`, { appointmentId });
    return { kind: "in_progress" };
  }
  return { kind: "claimed", ...delivery };
}

async function resetChannelDelivery(
  queue: ChannelQueue,
  deliveryId: string,
  error: unknown,
  channel: DeliveryChannel,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const message =
    error instanceof Error ? error.message : "The notification provider could not be reached.";
  console.error(`${channelLogPrefix(queue, channel)} send failed`, error);
  await supabaseAdmin
    .from(queue)
    .update({
      status: "pending",
      last_error: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("id", deliveryId);
}

async function markChannelDeliverySent(
  queue: ChannelQueue,
  deliveryId: string,
  channel: DeliveryChannel,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from(queue)
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", deliveryId);
  if (error) console.error(`${channelLogPrefix(queue, channel)} sent-state update failed`, error);
}

async function markChannelDeliverySkipped(
  queue: ChannelQueue,
  deliveryId: string,
  channel: DeliveryChannel,
  reason: string,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from(queue)
    .update({ status: "skipped", last_error: reason, updated_at: new Date().toISOString() })
    .eq("id", deliveryId);
  if (error)
    console.error(`${channelLogPrefix(queue, channel)} skipped-state update failed`, error);
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
  const { emailTransport, sendEmail } = await import("./email.server");
  const configured = emailTransport();
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  if ("error" in configured) {
    console.error("[Completion email] configuration unavailable", { reason: configured.error });
    const { error } = await supabaseAdmin
      .from("appointment_completion_notifications")
      .update({
        last_error: configured.error.slice(0, 500),
        updated_at: new Date().toISOString(),
      })
      .eq("appointment_id", appointmentId)
      .eq("channel", "email")
      .eq("status", "pending");
    if (error) console.error("[Completion email] configuration-state update failed", error);
    return {
      sent: false,
      error: configured.error,
    };
  }
  const claim = await claimChannelDelivery(
    "appointment_completion_notifications",
    appointmentId,
    "email",
  );
  if (claim.kind === "sent") return { sent: true };
  if (claim.kind === "in_progress") return { sent: false, error: null };
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
    const serviceList = appointment.services
      .map((service) => `<li>${escapeHtml(service)}</li>`)
      .join("");
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
    await sendEmail(configured.transport, {
      to: claim.recipient,
      subject: `Service completed - ${appointment.reference_code}`,
      html,
      text,
      idempotencyKey: `appointment-completion-${claim.id}`,
    });
    await markChannelDeliverySent("appointment_completion_notifications", claim.id, "email");
    return { sent: true };
  } catch (error) {
    await resetChannelDelivery("appointment_completion_notifications", claim.id, error, "email");
    return {
      sent: false,
      error: "The service was completed, but the completion email could not be sent.",
    };
  }
}

async function sendQueuedCompletionSms(appointmentId: string): Promise<ConfirmationSmsResult> {
  const claim = await claimChannelDelivery(
    "appointment_completion_notifications",
    appointmentId,
    "sms",
  );
  if (claim.kind === "sent") return { sent: true, skipped: false, error: null };
  if (claim.kind === "skipped") return { sent: false, skipped: true, error: null };
  if (claim.kind === "in_progress") return { sent: false, skipped: false, error: null };
  if (claim.kind === "error") return { sent: false, skipped: false, error: claim.error };
  if (claim.kind !== "claimed") {
    return { sent: false, skipped: false, error: "The completion SMS could not be queued." };
  }

  const configured = smsConfig();
  if ("error" in configured) {
    await resetChannelDelivery(
      "appointment_completion_notifications",
      claim.id,
      new Error(configured.error),
      "sms",
    );
    return { sent: false, skipped: false, error: configured.error };
  }

  try {
    if (await isCopiedBooking(configured.config, appointmentId)) {
      await markChannelDeliverySkipped(
        "appointment_completion_notifications",
        claim.id,
        "sms",
        COPIED_BOOKING_NOT_TEXTED,
      );
      return { sent: false, skipped: true, error: COPIED_BOOKING_NOT_TEXTED };
    }
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
    await sendSms(configured.config, recipient, message);
    await markChannelDeliverySent("appointment_completion_notifications", claim.id, "sms");
    return { sent: true, skipped: false, error: null };
  } catch (error) {
    await resetChannelDelivery("appointment_completion_notifications", claim.id, error, "sms");
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

type CustomerEmailResult = { sent: true } | { sent: false; error: string };

/** The shop's contact details as set in Settings, for customer emails and texts. */
async function shopContact(): Promise<ShopContact> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("shop_settings")
    .select("shop_name,contact_number,contact_email")
    .eq("id", true)
    .maybeSingle();
  if (error) console.warn("[Customer email] shop contact lookup failed; using defaults", error);
  return {
    name: data?.shop_name?.trim() || SHOP.name,
    phone: data?.contact_number?.trim() || SHOP.phone,
    email: data?.contact_email?.trim() || SHOP.email,
  };
}

/**
 * A public page on this site, from the admin's own request. Links are left
 * out when the console runs on a local development address.
 */
function publicPageUrl(path: string) {
  const origin = getRequest()?.headers.get("origin");
  return origin?.startsWith("https://") ? `${origin}${path}` : null;
}

/** One customer email. Failures are logged and reported to the admin, not retried. */
async function deliverCustomerEmail(
  label: string,
  to: string,
  content: EmailContent,
  failure: string,
): Promise<CustomerEmailResult> {
  const { emailTransport, sendEmail } = await import("./email.server");
  const configured = emailTransport();
  if ("error" in configured) {
    console.error(`[${label}] configuration unavailable`, { reason: configured.error });
    return { sent: false, error: `${failure} ${configured.error}` };
  }
  try {
    await sendEmail(configured.transport, { to, ...content });
    return { sent: true };
  } catch (error) {
    console.error(`[${label}] send failed`, error);
    return { sent: false, error: failure };
  }
}

type NoticeDelivery = { sent: boolean; error: string | null };

/** One text message to a customer. Failures are logged and reported to the admin, not retried. */
async function deliverCustomerSms(
  label: string,
  appointmentId: string,
  phone: string,
  message: string,
  failure: string,
): Promise<NoticeDelivery> {
  const recipient = formatPhilippineMobileE164(phone);
  if (!recipient) return { sent: false, error: `${failure} The mobile number is invalid.` };
  const configured = smsConfig();
  if ("error" in configured) {
    console.error(`[${label}] configuration unavailable`, { reason: configured.error });
    return { sent: false, error: `${failure} ${configured.error}` };
  }
  try {
    if (await isCopiedBooking(configured.config, appointmentId)) {
      return { sent: false, error: COPIED_BOOKING_NOT_TEXTED };
    }
    await sendSms(configured.config, recipient, message);
    return { sent: true, error: null };
  } catch (error) {
    console.error(`[${label}] send failed`, error);
    return { sent: false, error: failure };
  }
}

/** The appointment details a customer notice needs, or null if it cannot be loaded. */
async function loadNoticeAppointment(appointmentId: string, status?: "rejected" | "confirmed") {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  let query = supabaseAdmin
    .from("appointments")
    .select(
      "reference_code,customer_name,email,phone,appointment_date,start_time,moto_brand,moto_model,plate_number,appointment_services(service_name)",
    )
    .eq("id", appointmentId);
  if (status) query = query.eq("status", status);
  const { data: appointment, error } = await query.maybeSingle();
  if (error || !appointment) {
    if (error) console.error("[Customer notice] appointment lookup failed", error);
    return null;
  }
  const summary: AppointmentSummary = {
    referenceCode: appointment.reference_code,
    customerName: appointment.customer_name,
    appointmentDate: appointment.appointment_date,
    startTime: appointment.start_time,
    services: (appointment.appointment_services ?? []).map((service) => service.service_name),
    motorcycle: [appointment.moto_brand, appointment.moto_model].filter(Boolean).join(" "),
    plateNumber: appointment.plate_number,
  };
  return {
    summary,
    email: appointment.email?.trim().toLowerCase() || null,
    phone: appointment.phone,
  };
}

/**
 * Emails and texts the customer at the same time. Without an email on file the
 * text alone is sent; the admin is asked to call only when neither went out.
 */
async function deliverNotice({
  label,
  outcome,
  appointmentId,
  appointment,
  email,
  sms,
}: {
  label: string;
  /** What happened, e.g. "The booking was rejected". */
  outcome: string;
  appointmentId: string;
  appointment: { email: string | null; phone: string };
  email: EmailContent;
  sms: string;
}): Promise<{ emailDelivery: NoticeDelivery; smsDelivery: NoticeDelivery }> {
  const [emailDelivery, smsDelivery] = await Promise.all([
    appointment.email
      ? deliverCustomerEmail(
          `${label} email`,
          appointment.email,
          email,
          `${outcome}, but the email to the customer could not be sent.`,
        ).then((result) => (result.sent ? { sent: true, error: null } : result))
      : Promise.resolve({ sent: false, error: null }),
    deliverCustomerSms(
      `${label} SMS`,
      appointmentId,
      appointment.phone,
      sms,
      `${outcome}, but the text message to the customer could not be sent.`,
    ),
  ]);
  if (!appointment.email && !smsDelivery.sent) {
    smsDelivery.error = `${smsDelivery.error} This customer has no email on file, so please let them know by phone.`;
  }
  return { emailDelivery, smsDelivery };
}

/** Tells the customer their pending booking request was not accepted. */
async function notifyBookingNotAccepted(appointmentId: string) {
  const appointment = await loadNoticeAppointment(appointmentId, "rejected");
  if (!appointment) {
    return {
      emailDelivery: {
        sent: false,
        error: "The booking was rejected, but the customer could not be notified.",
      },
      smsDelivery: { sent: false, error: null },
    };
  }
  const contact = await shopContact();
  return deliverNotice({
    label: "Booking not accepted",
    outcome: "The booking was rejected",
    appointmentId,
    appointment,
    email: bookingNotAcceptedEmail({
      appointment: appointment.summary,
      contact,
      bookingUrl: publicPageUrl("/book"),
    }),
    sms: bookingNotAcceptedSms({ appointment: appointment.summary, contact }),
  });
}

/** Tells the customer their reschedule request was not approved. */
async function notifyRescheduleNotApproved(appointmentId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [appointment, requestRes] = await Promise.all([
    loadNoticeAppointment(appointmentId),
    // Rejecting clears the request from the appointment; its history keeps the requested time.
    supabaseAdmin
      .from("appointment_reschedule_history")
      .select("to_date,to_start_time")
      .eq("appointment_id", appointmentId)
      .eq("decision", "rejected")
      .order("approved_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!appointment) {
    return {
      emailDelivery: {
        sent: false,
        error: "The reschedule request was rejected, but the customer could not be notified.",
      },
      smsDelivery: { sent: false, error: null },
    };
  }
  if (requestRes.error) {
    console.warn("[Reschedule not approved] request lookup failed", requestRes.error);
  }
  const contact = await shopContact();
  const requested = {
    requestedDate: requestRes.data?.to_date ?? null,
    requestedStartTime: requestRes.data?.to_start_time ?? null,
  };
  return deliverNotice({
    label: "Reschedule not approved",
    outcome: "The reschedule request was rejected",
    appointmentId,
    appointment,
    email: rescheduleNotApprovedEmail({
      appointment: appointment.summary,
      ...requested,
      contact,
      appointmentUrl: publicPageUrl("/my-appointment"),
    }),
    sms: rescheduleNotApprovedSms({ appointment: appointment.summary, ...requested, contact }),
  });
}

/** Tries per customer message, the first included, before the admin is asked to step in. */
const MAX_DELIVERY_ATTEMPTS = 5;

/** Most messages one scheduled run sends, so a backlog never outlasts the request. */
const SCHEDULED_RUN_SEND_LIMIT = 20;

/** Waits 5, 10, 20, then 40 minutes after each failed try. */
function retryIsDue(attemptCount: number, updatedAt: string) {
  const waitMinutes = 5 * 2 ** Math.max(0, attemptCount - 1);
  return Date.parse(updatedAt) <= Date.now() - waitMinutes * 60_000;
}

/** When an appointment starts, from its Philippine date and time. */
function appointmentStartMs(date: string, time: string) {
  return Date.parse(`${date}T${time.slice(0, 5)}:00+08:00`);
}

/** Sends one queued reminder. A failure stays queued for the next scheduled run. */
async function sendQueuedReminder(
  appointmentId: string,
  channel: DeliveryChannel,
  siteOrigin: string | null,
): Promise<NoticeDelivery> {
  const queue = "appointment_reminders";
  const claim = await claimChannelDelivery(queue, appointmentId, channel);
  if (claim.kind !== "claimed") {
    return { sent: claim.kind === "sent", error: claim.kind === "error" ? claim.error : null };
  }

  try {
    const appointment = await loadNoticeAppointment(appointmentId, "confirmed");
    if (
      !appointment ||
      appointmentStartMs(appointment.summary.appointmentDate, appointment.summary.startTime) <=
        Date.now()
    ) {
      await markChannelDeliverySkipped(
        queue,
        claim.id,
        channel,
        "No reminder was sent: the appointment is no longer confirmed or has already started.",
      );
      return { sent: false, error: null };
    }
    const contact = await shopContact();

    if (channel === "email") {
      const { emailTransport, sendEmail } = await import("./email.server");
      const configured = emailTransport();
      if ("error" in configured) throw new Error(configured.error);
      await sendEmail(configured.transport, {
        to: claim.recipient,
        ...appointmentReminderEmail({
          appointment: appointment.summary,
          contact,
          appointmentUrl: siteOrigin ? `${siteOrigin}/my-appointment` : null,
        }),
        idempotencyKey: `appointment-reminder-${claim.id}`,
      });
    } else {
      const configured = smsConfig();
      if ("error" in configured) throw new Error(configured.error);
      if (await isCopiedBooking(configured.config, appointmentId)) {
        await markChannelDeliverySkipped(queue, claim.id, channel, COPIED_BOOKING_NOT_TEXTED);
        return { sent: false, error: null };
      }
      const recipient = formatPhilippineMobileE164(claim.recipient);
      if (!recipient) throw new Error("The customer's mobile number is invalid.");
      await sendSms(
        configured.config,
        recipient,
        appointmentReminderSms({ appointment: appointment.summary, contact }),
      );
    }
    await markChannelDeliverySent(queue, claim.id, channel);
    return { sent: true, error: null };
  } catch (error) {
    await resetChannelDelivery(queue, claim.id, error, channel);
    return {
      sent: false,
      error: `The ${channelDeliveryLabel(queue, channel)} could not be sent.`,
    };
  }
}

/** A customer message waiting in one of the delivery queues. */
type QueuedDelivery = {
  kind: "confirmation" | "completion" | "reminder";
  queue: "appointment_confirmation_emails" | "appointment_confirmation_sms" | ChannelQueue;
  id: string;
  appointmentId: string;
  channel: DeliveryChannel;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
};

type DeliveryAppointment = {
  id: string;
  status: string;
  appointment_date: string;
  start_time: string;
  reference_code: string;
  customer_name: string;
  phone: string;
};

async function loadQueuedDeliveries(): Promise<QueuedDelivery[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [emails, texts, completions, reminders] = await Promise.all([
    supabaseAdmin
      .from("appointment_confirmation_emails")
      .select("id,appointment_id,attempt_count,created_at,updated_at,last_error")
      .eq("status", "pending")
      .order("created_at")
      .limit(50),
    supabaseAdmin
      .from("appointment_confirmation_sms")
      .select("id,appointment_id,attempt_count,created_at,updated_at,last_error")
      .eq("status", "pending")
      .order("created_at")
      .limit(50),
    supabaseAdmin
      .from("appointment_completion_notifications")
      .select("id,appointment_id,channel,attempt_count,created_at,updated_at,last_error")
      .eq("status", "pending")
      .order("created_at")
      .limit(50),
    supabaseAdmin
      .from("appointment_reminders")
      .select("id,appointment_id,channel,attempt_count,created_at,updated_at,last_error")
      .eq("status", "pending")
      .order("created_at")
      .limit(50),
  ]);
  const error = emails.error ?? texts.error ?? completions.error ?? reminders.error;
  if (error) throw new Error(`The delivery queues could not be read: ${error.message}`);

  const toDelivery =
    (kind: QueuedDelivery["kind"], queue: QueuedDelivery["queue"], channel?: DeliveryChannel) =>
    (row: {
      id: string;
      appointment_id: string;
      channel?: string;
      attempt_count: number;
      created_at: string;
      updated_at: string;
      last_error: string | null;
    }): QueuedDelivery => ({
      kind,
      queue,
      id: row.id,
      appointmentId: row.appointment_id,
      channel: channel ?? (row.channel === "email" ? "email" : "sms"),
      attemptCount: row.attempt_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastError: row.last_error,
    });
  return [
    ...(emails.data ?? []).map(
      toDelivery("confirmation", "appointment_confirmation_emails", "email"),
    ),
    ...(texts.data ?? []).map(toDelivery("confirmation", "appointment_confirmation_sms", "sms")),
    ...(completions.data ?? []).map(
      toDelivery("completion", "appointment_completion_notifications"),
    ),
    ...(reminders.data ?? []).map(toDelivery("reminder", "appointment_reminders")),
  ];
}

/** "confirmation SMS", "reminder email" and so on, for the admin. */
function queuedDeliveryLabel(delivery: QueuedDelivery) {
  return `${delivery.kind} ${delivery.channel === "email" ? "email" : "SMS"}`;
}

/** Why a queued message is no longer worth sending, or null while it still is. */
function deliveryNoLongerNeeded(
  delivery: QueuedDelivery,
  appointment: DeliveryAppointment | undefined,
) {
  if (!appointment) return "Not sent: the appointment no longer exists.";
  if (delivery.kind === "completion") {
    if (appointment.status !== "completed") return "Not sent: the service is no longer completed.";
    return Date.parse(delivery.createdAt) < Date.now() - 3 * 24 * 60 * 60_000
      ? "Not sent: the service was completed more than 3 days ago."
      : null;
  }
  if (appointment.status !== "confirmed") {
    return `Not sent: the appointment is now ${appointment.status.replace("_", " ")}.`;
  }
  return appointmentStartMs(appointment.appointment_date, appointment.start_time) <= Date.now()
    ? "Not sent: the appointment time has passed."
    : null;
}

async function markQueuedDeliverySkipped(delivery: QueuedDelivery, reason: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin
    .from(delivery.queue)
    .update({
      status: "skipped",
      last_error: reason.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("id", delivery.id)
    .eq("status", "pending");
  if (error) console.error("[Scheduled notifications] skipped-state update failed", error);
}

/** Stops retrying a message and asks the admin to contact the customer instead. */
async function giveUpDelivery(delivery: QueuedDelivery, appointment: DeliveryAppointment) {
  const label = queuedDeliveryLabel(delivery);
  const reason = delivery.lastError
    ? ` The last error was: ${delivery.lastError.slice(0, 200)}`
    : "";
  await markQueuedDeliverySkipped(
    delivery,
    `Gave up after ${delivery.attemptCount} tries.${reason}`,
  );
  const { alertAdmin } = await import("./admin-alerts.server");
  const phone = normalizePhilippineMobile(appointment.phone) ?? appointment.phone;
  await alertAdmin({
    type: "customer_notice_failed",
    appointmentId: delivery.appointmentId,
    title: `${delivery.channel === "sms" ? "Couldn't text" : "Couldn't email"} ${appointment.customer_name}`,
    message: `The ${label} for ${appointment.reference_code} could not be sent after ${delivery.attemptCount} tries.${reason} Please contact the customer at ${phone}.`,
  });
}

/**
 * The scheduled run: queues reminders that are due, sends them, retries
 * customer messages that failed, and alerts the admin about any that still
 * fail after MAX_DELIVERY_ATTEMPTS tries. siteOrigin is the site's https
 * address, for links in reminder emails.
 */
export async function runScheduledNotifications(siteOrigin: string | null) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin
    .from("scheduled_notification_runs")
    .upsert({ id: true, last_started_at: new Date().toISOString() });

  try {
    const queued = await supabaseAdmin.rpc("queue_due_appointment_reminders");
    if (queued.error) throw new Error(`Reminders could not be queued: ${queued.error.message}`);

    const deliveries = await loadQueuedDeliveries();
    const appointmentIds = [...new Set(deliveries.map((delivery) => delivery.appointmentId))];
    const appointments = new Map<string, DeliveryAppointment>();
    if (appointmentIds.length) {
      const { data, error } = await supabaseAdmin
        .from("appointments")
        .select("id,status,appointment_date,start_time,reference_code,customer_name,phone")
        .in("id", appointmentIds);
      if (error) throw new Error(`Appointments could not be read: ${error.message}`);
      for (const appointment of data) appointments.set(appointment.id, appointment);
    }

    let skipped = 0;
    let gaveUp = 0;
    // Confirmations and completions send both channels together, so one send per appointment.
    const sends = new Map<string, () => Promise<unknown>>();
    for (const delivery of deliveries) {
      const appointment = appointments.get(delivery.appointmentId);
      const notNeeded = deliveryNoLongerNeeded(delivery, appointment);
      if (notNeeded || !appointment) {
        await markQueuedDeliverySkipped(delivery, notNeeded ?? "Not sent.");
        skipped += 1;
        continue;
      }
      if (delivery.attemptCount >= MAX_DELIVERY_ATTEMPTS) {
        await giveUpDelivery(delivery, appointment);
        gaveUp += 1;
        continue;
      }
      // A new reminder goes out at once. Anything else waits, so a first send
      // still being made by an admin's own request is not repeated.
      const due =
        (delivery.kind === "reminder" && delivery.attemptCount === 0) ||
        retryIsDue(delivery.attemptCount, delivery.updatedAt);
      if (!due) continue;
      if (delivery.kind === "reminder") {
        sends.set(`reminder:${delivery.id}`, () =>
          sendQueuedReminder(delivery.appointmentId, delivery.channel, siteOrigin),
        );
      } else if (delivery.kind === "confirmation") {
        sends.set(`confirmation:${delivery.appointmentId}`, () =>
          sendConfirmationNotifications(delivery.appointmentId),
        );
      } else {
        sends.set(`completion:${delivery.appointmentId}`, () =>
          sendCompletionNotifications(delivery.appointmentId),
        );
      }
    }

    const batch = [...sends.values()].slice(0, SCHEDULED_RUN_SEND_LIMIT);
    for (const send of batch) {
      try {
        await send();
      } catch (error) {
        console.error("[Scheduled notifications] send failed", error);
      }
    }

    await supabaseAdmin
      .from("scheduled_notification_runs")
      .update({ last_finished_at: new Date().toISOString(), last_error: null })
      .eq("id", true);
    return { remindersQueued: queued.data ?? 0, sent: batch.length, skipped, gaveUp };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The scheduled run failed.";
    console.error("[Scheduled notifications] run failed", error);
    await supabaseAdmin
      .from("scheduled_notification_runs")
      .update({ last_error: message.slice(0, 500) })
      .eq("id", true);
    throw error;
  }
}

async function requireActiveAdminSession() {
  const client = authenticatedSupabaseClient();
  const { data: isActive, error } = await client.rpc("validate_admin_session");
  if (error || !isActive) {
    throw new Error("Your administrator session has expired. Please sign in again.");
  }
}

/**
 * A provider outage or a deployment during delivery can leave an already-approved
 * notification pending. Retrying the durable queue from an active admin session
 * recovers those messages without changing an appointment or exposing the queue
 * to the browser.
 */
export const retryPendingCustomerNotifications = createServerFn({ method: "POST" }).handler(
  async () => {
    await requireActiveAdminSession();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [confirmationEmailRows, confirmationSmsRows, completionRows] = await Promise.all([
      supabaseAdmin
        .from("appointment_confirmation_emails")
        .select("appointment_id")
        .in("status", ["pending", "sending"])
        .limit(25),
      supabaseAdmin
        .from("appointment_confirmation_sms")
        .select("appointment_id")
        .in("status", ["pending", "sending"])
        .limit(25),
      supabaseAdmin
        .from("appointment_completion_notifications")
        .select("appointment_id")
        .in("status", ["pending", "sending"])
        .limit(25),
    ]);
    const queueError =
      confirmationEmailRows.error ?? confirmationSmsRows.error ?? completionRows.error;
    if (queueError) {
      console.error("[Customer notifications] retry queue lookup failed", queueError);
      return { ok: false as const };
    }

    const confirmationAppointmentIds = new Set([
      ...(confirmationEmailRows.data ?? []).map((delivery) => delivery.appointment_id),
      ...(confirmationSmsRows.data ?? []).map((delivery) => delivery.appointment_id),
    ]);
    const completionAppointmentIds = new Set(
      (completionRows.data ?? []).map((delivery) => delivery.appointment_id),
    );
    await Promise.allSettled([
      ...Array.from(confirmationAppointmentIds, sendConfirmationNotifications),
      ...Array.from(completionAppointmentIds, sendCompletionNotifications),
    ]);
    const attempted = confirmationAppointmentIds.size + completionAppointmentIds.size;
    if (attempted) {
      console.info("[Customer notifications] retried durable deliveries", {
        confirmationAppointments: confirmationAppointmentIds.size,
        completionAppointments: completionAppointmentIds.size,
      });
    }
    return { ok: true as const, attempted };
  },
);

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
    if (data.decision === "rejected") {
      const { emailDelivery, smsDelivery } = await notifyBookingNotAccepted(data.appointmentId);
      return {
        ok: true as const,
        emailSent: emailDelivery.sent,
        emailError: emailDelivery.error,
        smsSent: smsDelivery.sent,
        smsError: smsDelivery.error,
      };
    }

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
    if (data.decision === "rejected") {
      const { emailDelivery, smsDelivery } = await notifyRescheduleNotApproved(data.appointmentId);
      return {
        ok: true as const,
        emailSent: emailDelivery.sent,
        emailError: emailDelivery.error,
        smsSent: smsDelivery.sent,
        smsError: smsDelivery.error,
      };
    }

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
    const isBeingRejected = existingAppointment.status === "pending" && data.status === "rejected";
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
    if (isBeingRejected) {
      const { emailDelivery, smsDelivery } = await notifyBookingNotAccepted(data.appointmentId);
      return {
        ok: true as const,
        emailSent: emailDelivery.sent,
        emailError: emailDelivery.error,
        smsSent: smsDelivery.sent,
        smsError: smsDelivery.error,
      };
    }
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
