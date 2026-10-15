// Email one-time codes that protect online cancellation and rescheduling.
// A correct code issues a short-lived token bound to one appointment and one
// action. Codes and tokens are only ever stored as SHA-256 hashes.
import { supabaseAdmin } from "@/integrations/supabase/client.server";

import { emailTransport, sendEmail } from "./email.server";
import { formatDateLong, formatTime } from "./shop";

export type AppointmentAction = "cancel" | "reschedule";

export const VERIFICATION_CODE_TTL_MINUTES = 10;
/** Long enough to choose a new schedule after verifying, short enough to limit reuse. */
export const VERIFICATION_TOKEN_TTL_MINUTES = 30;

export const VERIFICATION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makeVerificationCode() {
  const random = new Uint32Array(1);
  const range = 1_000_000;
  const unbiasedUpperBound = Math.floor(0x1_0000_0000 / range) * range;
  let value: number;
  do {
    crypto.getRandomValues(random);
    value = random[0] ?? 0;
  } while (value >= unbiasedUpperBound);

  return String(value % range).padStart(6, "0");
}

/** 32 random bytes as unpadded base64url (43 characters). */
function makeVerificationToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString("base64url");
}

export async function issueActionCode(
  appointmentId: string,
  action: AppointmentAction,
): Promise<{ code: string; challengeId: string } | null> {
  const now = new Date().toISOString();
  // Keep the table small: expired codes and expired tokens are never used again.
  const cleanup = await supabaseAdmin
    .from("appointment_action_verifications")
    .delete()
    .eq("appointment_id", appointmentId)
    .eq("action", action)
    .lt("expires_at", now)
    .or(`token_expires_at.is.null,token_expires_at.lt."${now}"`);
  if (cleanup.error) {
    console.error("[Appointment verification] cleanup failed", cleanup.error);
  }

  const code = makeVerificationCode();
  const { data, error } = await supabaseAdmin
    .from("appointment_action_verifications")
    .insert({
      appointment_id: appointmentId,
      action,
      code_hash: await sha256(code),
      expires_at: new Date(Date.now() + VERIFICATION_CODE_TTL_MINUTES * 60_000).toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[Appointment verification] code creation failed", error);
    return null;
  }
  return { code, challengeId: data.id };
}

export async function discardActionCode(challengeId: string) {
  const { error } = await supabaseAdmin
    .from("appointment_action_verifications")
    .delete()
    .eq("id", challengeId);
  if (error) console.error("[Appointment verification] code cleanup failed", error);
}

export type VerifyActionCodeResult =
  | { outcome: "verified"; token: string; expiresAt: string }
  | { outcome: "invalid" | "expired" | "unavailable" };

export async function verifyActionCode(
  appointmentId: string,
  action: AppointmentAction,
  code: string,
): Promise<VerifyActionCodeResult> {
  const token = makeVerificationToken();
  const { data, error } = await supabaseAdmin.rpc("verify_appointment_action_code", {
    p_appointment_id: appointmentId,
    p_action: action,
    p_code_hash: await sha256(code),
    p_token_hash: await sha256(token),
    p_token_ttl_seconds: VERIFICATION_TOKEN_TTL_MINUTES * 60,
  });
  if (error) {
    console.error("[Appointment verification] code verification failed", error);
    return { outcome: "unavailable" };
  }
  if (data === "verified") {
    return {
      outcome: "verified",
      token,
      // The database sets the authoritative expiry; this copy only lets the
      // browser ask for a fresh code before sending a request it would reject.
      expiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MINUTES * 60_000).toISOString(),
    };
  }
  return { outcome: data === "invalid" ? "invalid" : "expired" };
}

export async function checkActionToken(
  appointmentId: string,
  action: AppointmentAction,
  token: string | undefined,
): Promise<"valid" | "invalid" | "unavailable"> {
  if (!token || !VERIFICATION_TOKEN_PATTERN.test(token)) return "invalid";
  const { data, error } = await supabaseAdmin
    .from("appointment_action_verifications")
    .select("id")
    .eq("token_hash", await sha256(token))
    .eq("appointment_id", appointmentId)
    .eq("action", action)
    .gt("token_expires_at", new Date().toISOString())
    .maybeSingle();
  if (error) {
    console.error("[Appointment verification] token check failed", error);
    return "unavailable";
  }
  return data ? "valid" : "invalid";
}

export async function sendActionCodeEmail(input: {
  to: string;
  code: string;
  action: AppointmentAction;
  reference: string;
  date: string;
  startTime: string;
}) {
  const configured = emailTransport();
  if ("error" in configured) {
    console.error("[Appointment verification] email configuration unavailable", {
      reason: configured.error,
    });
    throw new Error("Email is not configured.");
  }

  const actionText = input.action === "cancel" ? "cancel" : "reschedule";
  const schedule = `${formatDateLong(input.date)} at ${formatTime(input.startTime)}`;
  await sendEmail(configured.transport, {
    to: input.to,
    subject: `Your code to ${actionText} appointment ${input.reference}`,
    text: [
      `Your Fake Rider Motorparts verification code is ${input.code}.`,
      "",
      `Use it to ${actionText} appointment ${input.reference} on ${schedule}. It expires in ${VERIFICATION_CODE_TTL_MINUTES} minutes.`,
      "",
      "If you did not request this, you can ignore this email. Your appointment has not been changed.",
    ].join("\n"),
  });
}
