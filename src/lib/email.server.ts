/**
 * Server-only outgoing email for customer notifications.
 *
 * Gmail SMTP is used when GMAIL_USER and GMAIL_APP_PASSWORD are set. The
 * password must be a Google App Password (Google Account > Security > App
 * passwords, which requires 2-Step Verification); Gmail rejects the normal
 * account password for SMTP. Without Gmail settings, Resend is used through
 * RESEND_API_KEY and RESEND_FROM_EMAIL.
 */

const EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENDER_NAME = "Fake Rider Motorparts";

export type EmailTransport =
  | { provider: "gmail"; user: string; appPassword: string; from: string }
  | { provider: "resend"; apiKey: string; from: string };

export type OutgoingEmail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Resend only: lets the provider ignore a repeated send of the same message. */
  idempotencyKey?: string;
};

function senderAddress(value: string) {
  const trimmed = value.trim();
  const namedAddress = trimmed.match(/^[^<>]*<\s*([^<>\s]+)\s*>$/);
  const address = (namedAddress?.[1] ?? trimmed).toLowerCase();
  return EMAIL_ADDRESS_PATTERN.test(address) ? address : null;
}

/** Remove credentials and personal details before provider errors are logged or stored. */
function redactProviderDetail(value: string) {
  return value
    .replace(/\bre_[A-Za-z0-9_-]+\b/g, "[redacted-api-key]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

export function emailTransport(): { transport: EmailTransport } | { error: string } {
  const gmailUser = process.env["GMAIL_USER"]?.trim();
  // Google shows App Passwords in groups of four characters; spaces are not part of it.
  const gmailAppPassword = process.env["GMAIL_APP_PASSWORD"]?.replace(/\s+/g, "");
  if (gmailUser || gmailAppPassword) {
    if (!gmailUser || !gmailAppPassword) {
      return {
        error:
          "Gmail email is partly configured. Set both GMAIL_USER and GMAIL_APP_PASSWORD in the server environment.",
      };
    }
    if (!EMAIL_ADDRESS_PATTERN.test(gmailUser)) {
      return { error: "Email is not configured correctly. GMAIL_USER must be an email address." };
    }
    return {
      transport: {
        provider: "gmail",
        user: gmailUser,
        appPassword: gmailAppPassword,
        from: `"${SENDER_NAME}" <${gmailUser}>`,
      },
    };
  }

  const apiKey = process.env["RESEND_API_KEY"]?.trim();
  const from = process.env["RESEND_FROM_EMAIL"]?.trim();
  if (!apiKey || !from) {
    return {
      error:
        "Email is not configured. Set GMAIL_USER and GMAIL_APP_PASSWORD (or RESEND_API_KEY and RESEND_FROM_EMAIL) in the server environment.",
    };
  }
  if (!senderAddress(from)) {
    return {
      error:
        "Email is not configured correctly. RESEND_FROM_EMAIL must be a valid email address or display-name address.",
    };
  }
  return { transport: { provider: "resend", apiKey, from } };
}

async function sendWithGmail(
  transport: Extract<EmailTransport, { provider: "gmail" }>,
  email: OutgoingEmail,
) {
  const { createTransport } = await import("nodemailer");
  const mailer = createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: transport.user, pass: transport.appPassword },
  });
  try {
    await mailer.sendMail({
      from: transport.from,
      to: email.to,
      subject: email.subject,
      text: email.text,
      ...(email.html ? { html: email.html } : {}),
    });
  } catch (error) {
    const detail = redactProviderDetail(error instanceof Error ? error.message : String(error));
    const responseCode = (error as { responseCode?: number } | null)?.responseCode;
    const hint =
      responseCode === 535 || /username and password not accepted|invalid login/i.test(detail)
        ? " GMAIL_APP_PASSWORD must be a Google App Password, not the account password."
        : "";
    throw new Error(`Gmail SMTP rejected the email: ${detail}.${hint}`);
  } finally {
    mailer.close();
  }
}

async function sendWithResend(
  transport: Extract<EmailTransport, { provider: "resend" }>,
  email: OutgoingEmail,
) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${transport.apiKey}`,
      "Content-Type": "application/json",
      ...(email.idempotencyKey ? { "Idempotency-Key": email.idempotencyKey } : {}),
    },
    body: JSON.stringify({
      from: transport.from,
      to: [email.to],
      subject: email.subject,
      text: email.text,
      ...(email.html ? { html: email.html } : {}),
    }),
  });
  if (response.ok) return;

  const body = await response.text();
  const detail = redactProviderDetail(body);
  // Resend's shared testing sender only delivers to the Resend account owner.
  const testingSender = /@resend\.dev>?$/i.test(transport.from)
    ? " RESEND_FROM_EMAIL uses Resend's testing sender, which only delivers to the Resend account owner's address."
    : "";
  throw new Error(
    `Resend returned ${response.status}${detail ? `: ${detail}` : "."}${testingSender}`,
  );
}

/** Send one email; throws with a redacted provider reason when delivery is refused. */
export async function sendEmail(transport: EmailTransport, email: OutgoingEmail) {
  if (transport.provider === "gmail") await sendWithGmail(transport, email);
  else await sendWithResend(transport, email);
}
