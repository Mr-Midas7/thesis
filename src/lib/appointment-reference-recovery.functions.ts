import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";

import type { EmailTransport } from "./email.server";

const recoveryEmailSchema = z
  .string()
  .trim()
  .email("Enter a valid email address.")
  .max(254)
  .transform((email) => email.toLocaleLowerCase());

const requestRecoverySchema = z.object({ email: recoveryEmailSchema });
const verifyRecoverySchema = z.object({
  email: recoveryEmailSchema,
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit verification code."),
});

type RateLimitResult = "allowed" | "limited" | "unavailable";

/** The configured mail transport, or null (with the reason logged) when email is not set up. */
async function recoveryEmailTransport(): Promise<EmailTransport | null> {
  const { emailTransport } = await import("./email.server");
  const configured = emailTransport();
  if ("error" in configured) {
    console.error("[Reference recovery] email configuration unavailable", {
      reason: configured.error,
    });
    return null;
  }
  return configured.transport;
}

function clientIp() {
  const request = getRequest();
  const platformIp =
    request?.headers.get("x-vercel-forwarded-for")?.trim() ||
    request?.headers.get("cf-connecting-ip")?.trim();
  return (
    platformIp ||
    request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request?.headers.get("x-real-ip")?.trim() ||
    "unknown"
  );
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function checkRateLimit(
  scope: "reference_recovery_email_request" | "reference_recovery_email_verify",
  email: string,
  limit: number,
): Promise<RateLimitResult> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const subjects = [await sha256(`ip:${clientIp()}`), await sha256(`email:${email}`)];
    for (const subject of subjects) {
      const { data, error } = await supabaseAdmin.rpc("enforce_public_rate_limit", {
        p_scope: scope,
        p_subject: subject,
        p_limit: limit,
        p_window_seconds: 15 * 60,
      });
      if (error) {
        console.error(`[Reference recovery] ${scope} rate limit failed`, error);
        return "unavailable";
      }
      if (data !== true) return "limited";
    }
    return "allowed";
  } catch (error) {
    console.error(`[Reference recovery] ${scope} rate limit failed`, error);
    return "unavailable";
  }
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

  const code = value % range;
  return String(code).padStart(6, "0");
}

async function sendEmail(
  transport: EmailTransport,
  recipient: string,
  subject: string,
  text: string,
) {
  const { sendEmail: sendWithTransport } = await import("./email.server");
  await sendWithTransport(transport, { to: recipient, subject, text });
}

const sentCodeMessage =
  "If an active booking uses that email address, we sent a verification code.";

export const requestReferenceRecoveryCode = createServerFn({ method: "POST" })
  .validator((input: unknown) => requestRecoverySchema.parse(input))
  .handler(async ({ data }) => {
    const rateLimit = await checkRateLimit("reference_recovery_email_request", data.email, 3);
    if (rateLimit !== "allowed") {
      return {
        ok: false as const,
        error:
          rateLimit === "limited"
            ? "Too many verification requests. Please wait a few minutes before trying again."
            : "Reference recovery is temporarily unavailable. Please try again shortly.",
      };
    }

    const config = await recoveryEmailTransport();
    if (!config) {
      return {
        ok: false as const,
        error: "Reference recovery email is not configured. Please contact the shop.",
      };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: appointment, error: appointmentError } = await supabaseAdmin
      .from("appointments")
      .select("id")
      .eq("email", data.email)
      .eq("is_archived", false)
      .limit(1)
      .maybeSingle();
    if (appointmentError) {
      console.error("[Reference recovery] email lookup failed", appointmentError);
      return {
        ok: false as const,
        error: "Reference recovery is temporarily unavailable. Please try again shortly.",
      };
    }
    if (!appointment) return { ok: true as const, message: sentCodeMessage };

    const verificationCode = makeVerificationCode();
    const { data: challenge, error: challengeError } = await supabaseAdmin
      .from("appointment_reference_recovery_challenges")
      .insert({
        email: data.email,
        code_hash: await sha256(verificationCode),
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      })
      .select("id")
      .single();
    if (challengeError || !challenge) {
      console.error("[Reference recovery] challenge creation failed", challengeError);
      return {
        ok: false as const,
        error: "Reference recovery is temporarily unavailable. Please try again shortly.",
      };
    }

    try {
      await sendEmail(
        config,
        data.email,
        "Your reference recovery verification code",
        `Your Fake Rider Motorparts verification code is ${verificationCode}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
      );
    } catch (error) {
      console.error("[Reference recovery] verification email failed", error);
      await supabaseAdmin
        .from("appointment_reference_recovery_challenges")
        .delete()
        .eq("id", challenge.id);
      return {
        ok: false as const,
        error: "We could not send the verification email. Please try again shortly.",
      };
    }

    return { ok: true as const, message: sentCodeMessage };
  });

export const verifyReferenceRecoveryCode = createServerFn({ method: "POST" })
  .validator((input: unknown) => verifyRecoverySchema.parse(input))
  .handler(async ({ data }) => {
    const rateLimit = await checkRateLimit("reference_recovery_email_verify", data.email, 8);
    if (rateLimit !== "allowed") {
      return {
        ok: false as const,
        error:
          rateLimit === "limited"
            ? "Too many verification attempts. Please request a new code in a few minutes."
            : "Reference recovery is temporarily unavailable. Please try again shortly.",
      };
    }

    const config = await recoveryEmailTransport();
    if (!config) {
      return {
        ok: false as const,
        error: "Reference recovery email is not configured. Please contact the shop.",
      };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: outcome, error: verificationError } = await supabaseAdmin.rpc(
      "consume_reference_recovery_challenge",
      { p_email: data.email, p_code_hash: await sha256(data.code) },
    );
    if (verificationError) {
      console.error("[Reference recovery] code verification failed", verificationError);
      return {
        ok: false as const,
        error: "Reference recovery is temporarily unavailable. Please try again shortly.",
      };
    }
    if (outcome !== "verified") {
      return {
        ok: false as const,
        error:
          outcome === "invalid"
            ? "That verification code is incorrect. Please try again."
            : "That verification code has expired or is no longer valid. Request a new code.",
      };
    }

    const { data: appointments, error: appointmentsError } = await supabaseAdmin
      .from("appointments")
      .select("reference_code")
      .eq("email", data.email)
      .eq("is_archived", false)
      .order("created_at", { ascending: false })
      .limit(20);
    if (appointmentsError) {
      console.error("[Reference recovery] reference lookup failed", appointmentsError);
      return {
        ok: false as const,
        error: "We could not retrieve your reference code. Please request a new verification code.",
      };
    }
    const references = Array.from(
      new Set((appointments ?? []).map((appointment) => appointment.reference_code)),
    );
    if (references.length === 0) {
      return {
        ok: false as const,
        error: "No active appointments were found for that verified email address.",
      };
    }

    try {
      await sendEmail(
        config,
        data.email,
        "Your Fake Rider Motorparts reference code",
        `Your appointment reference code${references.length === 1 ? " is" : "s are"}:\n\n${references.map((reference) => `- ${reference}`).join("\n")}\n\nKeep ${references.length === 1 ? "this code" : "these codes"} for appointment tracking.`,
      );
    } catch (error) {
      console.error("[Reference recovery] reference email failed", error);
      return {
        ok: false as const,
        error: "We could not email your reference code. Please request a new verification code.",
      };
    }

    return {
      ok: true as const,
      message: "Your reference code has been sent to your verified email address.",
    };
  });
