/**
 * Wording and formatting for customer emails. These are plain functions with
 * no secrets or network access, so the content can be checked without sending.
 */

export function escapeHtml(value: string | number | null | undefined) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function formatAppointmentDate(date: string) {
  return new Intl.DateTimeFormat("en-PH", {
    dateStyle: "full",
    timeZone: "Asia/Manila",
  }).format(new Date(`${date}T12:00:00+08:00`));
}

export function formatAppointmentTime(time: string) {
  const [hour = "0", minute = "0"] = time.slice(0, 5).split(":");
  const date = new Date(`2000-01-01T${hour.padStart(2, "0")}:${minute}:00+08:00`);
  return new Intl.DateTimeFormat("en-PH", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Manila",
  }).format(date);
}

export type ShopContact = { name: string; phone: string; email: string };

export type EmailContent = { subject: string; text: string; html: string };

export type AppointmentSummary = {
  referenceCode: string;
  customerName: string;
  appointmentDate: string;
  startTime: string;
  services: string[];
  motorcycle: string;
  plateNumber: string;
};

function schedule(date: string, time: string) {
  return `${formatAppointmentDate(date)} at ${formatAppointmentTime(time)}`;
}

function contactText(contact: ShopContact) {
  return contact.email ? `${contact.phone} or ${contact.email}` : contact.phone;
}

function contactHtml(contact: ShopContact) {
  return contact.email
    ? `${escapeHtml(contact.phone)} or <a href="mailto:${escapeHtml(contact.email)}">${escapeHtml(contact.email)}</a>`
    : escapeHtml(contact.phone);
}

function link(url: string, label: string) {
  return `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
}

/** Sent when the shop rejects a pending booking request. */
export function bookingNotAcceptedEmail({
  appointment,
  contact,
  bookingUrl,
}: {
  appointment: AppointmentSummary;
  contact: ShopContact;
  /** The public booking page, when the site address is known. */
  bookingUrl?: string | null;
}): EmailContent {
  const requested = schedule(appointment.appointmentDate, appointment.startTime);
  const services = appointment.services.join(", ") || "Not listed";
  const text = [
    `Hello ${appointment.customerName},`,
    "",
    `We're sorry, but we could not accept your booking request at ${contact.name}.`,
    "",
    `Reference code: ${appointment.referenceCode}`,
    `Requested schedule: ${requested}`,
    `Services: ${services}`,
    `Motorcycle: ${appointment.motorcycle} (plate ${appointment.plateNumber})`,
    "",
    "This time is no longer reserved for you. You are welcome to book a different date and time" +
      (bookingUrl ? `: ${bookingUrl}` : " on our website."),
    `If you have questions, contact us at ${contactText(contact)}.`,
  ].join("\n");
  const html = [
    `<p>Hello ${escapeHtml(appointment.customerName)},</p>`,
    `<p>We're sorry, but we could not accept your booking request at ${escapeHtml(contact.name)}.</p>`,
    `<p><strong>Reference code:</strong> ${escapeHtml(appointment.referenceCode)}<br />`,
    `<strong>Requested schedule:</strong> ${escapeHtml(requested)}<br />`,
    `<strong>Services:</strong> ${escapeHtml(services)}<br />`,
    `<strong>Motorcycle:</strong> ${escapeHtml(appointment.motorcycle)} (plate ${escapeHtml(appointment.plateNumber)})</p>`,
    `<p>This time is no longer reserved for you. You are welcome to ${bookingUrl ? link(bookingUrl, "book a different date and time") : "book a different date and time on our website"}.</p>`,
    `<p>If you have questions, contact us at ${contactHtml(contact)}.</p>`,
  ].join("");
  return {
    subject: `Booking request not accepted - ${appointment.referenceCode}`,
    text,
    html,
  };
}

/** Sent when the shop rejects a customer's reschedule request. */
export function rescheduleNotApprovedEmail({
  appointment,
  requestedDate,
  requestedStartTime,
  contact,
  appointmentUrl,
}: {
  /** The customer's current appointment, which stays as it is. */
  appointment: AppointmentSummary;
  requestedDate: string | null;
  requestedStartTime: string | null;
  contact: ShopContact;
  /** The public My Appointment page, when the site address is known. */
  appointmentUrl?: string | null;
}): EmailContent {
  const requested =
    requestedDate && requestedStartTime ? schedule(requestedDate, requestedStartTime) : null;
  const current = schedule(appointment.appointmentDate, appointment.startTime);
  const services = appointment.services.join(", ") || "Not listed";
  const request = requested
    ? `your request to move your appointment to ${requested}`
    : "your request to reschedule your appointment";
  const text = [
    `Hello ${appointment.customerName},`,
    "",
    `We could not approve ${request}.`,
    "",
    "Your current appointment has not changed:",
    `Reference code: ${appointment.referenceCode}`,
    `Schedule: ${current}`,
    `Services: ${services}`,
    "",
    "If this schedule no longer works for you, you can request a different date" +
      (appointmentUrl ? ` on the My Appointment page: ${appointmentUrl}` : " on our website."),
    `If you have questions, contact us at ${contactText(contact)}.`,
  ].join("\n");
  const html = [
    `<p>Hello ${escapeHtml(appointment.customerName)},</p>`,
    `<p>We could not approve ${escapeHtml(request)}.</p>`,
    `<p><strong>Your current appointment has not changed:</strong><br />`,
    `<strong>Reference code:</strong> ${escapeHtml(appointment.referenceCode)}<br />`,
    `<strong>Schedule:</strong> ${escapeHtml(current)}<br />`,
    `<strong>Services:</strong> ${escapeHtml(services)}</p>`,
    `<p>If this schedule no longer works for you, you can request a different date ${appointmentUrl ? `on the ${link(appointmentUrl, "My Appointment page")}` : "on our website"}.</p>`,
    `<p>If you have questions, contact us at ${contactHtml(contact)}.</p>`,
  ].join("");
  return {
    subject: `Reschedule request not approved - ${appointment.referenceCode}`,
    text,
    html,
  };
}
