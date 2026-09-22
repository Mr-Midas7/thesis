import { z } from "zod";

export const SHOP = {
  name: "Fake Rider Motorparts",
  tagline: "Motorparts, Accessories & Race-Grade Service",
  address: "Purok Bangkal Sta. Cruz, Baclayon, Bohol, Philippines",
  hours: "Monday to Saturday, 8:00 AM - 5:00 PM",
  phone: "0916 126 3317",
  email: "joemartato4@gmail.com",
  facebook: "https://www.facebook.com/profile.php?id=100082988659961",
  messenger: "https://www.facebook.com/messages/t/101547759281909/",
  noticeHours: 48,
};

/** Default copy shown on the customer booking form; administrators can replace it in Settings. */
export const DEFAULT_BOOKING_TERMS = `Bookings are subject to shop confirmation. Please arrive 15 minutes before your slot. Late arrivals beyond 30 minutes may be rescheduled. Quoted prices are starting rates; parts and additional labor are billed separately. The shop is not liable for personal items left on the unit.

Cancellations must be made at least ${SHOP.noticeHours} hours before the schedule.

We use your name, contact details, motorcycle details, selected services, and notes only to manage this booking, contact you about it, and provide shop services. We do not sell your information.`;

export const APPOINTMENT_STATUSES = [
  "pending",
  "confirmed",
  "in_progress",
  "completed",
  "rescheduled",
  "cancelled",
  "rejected",
  "no_show",
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

export function statusLabel(status: string) {
  return status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function statusTone(status: string) {
  switch (status) {
    case "confirmed":
      return "border-emerald-500/30 bg-emerald-500/15 text-emerald-400";
    case "in_progress":
      return "bg-accent/15 text-accent border-accent/30";
    case "completed":
      return "border-sky-500/30 bg-sky-500/15 text-sky-400";
    case "rescheduled":
      return "bg-accent/15 text-accent border-accent/30";
    case "cancelled":
    case "rejected":
    case "no_show":
      return "bg-destructive/15 text-destructive border-destructive/30";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

/** Shared display treatment for records that can be enabled or deactivated. */
export function activeStatusTone(isActive: boolean) {
  return isActive
    ? "border-emerald-500/45 bg-emerald-500/20 text-emerald-300"
    : "border-border bg-muted text-muted-foreground";
}

export function formatPHP(value: number | string | null | undefined) {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatTime(value: string) {
  const [h, m] = value.split(":");
  const hour = Number(h);
  const suffix = hour >= 12 ? "PM" : "AM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${m} ${suffix}`;
}

export const DEFAULT_BOOKING_HOURS = {
  openingTime: "08:00",
  closingTime: "17:00",
} as const;

export type BookingHours = {
  openingTime: string;
  closingTime: string;
};

const BOOKING_INTERVAL_MINUTES = 30;

export type BookingCapacityConfig = {
  startTime: string;
  capacity: number;
};

export type BookingTimeSlot = {
  id: string;
  startTime: string;
  endTime: string;
  capacity: number;
};

export function timeToMinutes(time: string) {
  const [hours = Number.NaN, minutes = Number.NaN] = time.slice(0, 5).split(":").map(Number);
  if (
    !Number.isInteger(hours) ||
    !Number.isInteger(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return Number.NaN;
  }
  return hours * 60 + minutes;
}

export function minutesToTime(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Operating hours must use the public booking grid's 30-minute increments. */
export function isValidBookingHours(openingTime: string, closingTime: string) {
  const openingMinutes = timeToMinutes(openingTime);
  const closingMinutes = timeToMinutes(closingTime);
  return (
    Number.isFinite(openingMinutes) &&
    Number.isFinite(closingMinutes) &&
    openingMinutes < closingMinutes &&
    openingMinutes % BOOKING_INTERVAL_MINUTES === 0 &&
    closingMinutes % BOOKING_INTERVAL_MINUTES === 0
  );
}

function resolveBookingHours(hours: BookingHours = DEFAULT_BOOKING_HOURS): BookingHours {
  return isValidBookingHours(hours.openingTime, hours.closingTime)
    ? { openingTime: hours.openingTime.slice(0, 5), closingTime: hours.closingTime.slice(0, 5) }
    : DEFAULT_BOOKING_HOURS;
}

export function shopTimeOptions(hours: BookingHours = DEFAULT_BOOKING_HOURS) {
  const { openingTime, closingTime } = resolveBookingHours(hours);
  const openingMinutes = timeToMinutes(openingTime);
  const closingMinutes = timeToMinutes(closingTime);
  const options: { value: string; label: string }[] = [];
  for (
    let minutes = openingMinutes;
    minutes <= closingMinutes;
    minutes += BOOKING_INTERVAL_MINUTES
  ) {
    const time24 = minutesToTime(minutes);
    options.push({ value: time24, label: formatTime(time24) });
  }
  return options;
}

/** True for a 30-minute booking start within the 8 AM–5 PM operating window. */
export function isBookingStartTime(time: string, hours: BookingHours = DEFAULT_BOOKING_HOURS) {
  const { openingTime, closingTime } = resolveBookingHours(hours);
  const minutes = timeToMinutes(time);
  const openingMinutes = timeToMinutes(openingTime);
  const closingMinutes = timeToMinutes(closingTime);
  return (
    Number.isFinite(minutes) &&
    minutes >= openingMinutes &&
    minutes < closingMinutes &&
    (minutes - openingMinutes) % BOOKING_INTERVAL_MINUTES === 0
  );
}

/** True when the entire appointment fits inside the shop's operating hours. */
export function isBookingTimeRangeWithinHours(
  time: string,
  durationMinutes: number,
  hours: BookingHours = DEFAULT_BOOKING_HOURS,
) {
  const { closingTime } = resolveBookingHours(hours);
  const startMinutes = timeToMinutes(time);
  return (
    isBookingStartTime(time, hours) &&
    Number.isFinite(durationMinutes) &&
    durationMinutes > 0 &&
    startMinutes + durationMinutes <= timeToMinutes(closingTime)
  );
}

/** Minutes of a booking that would fall after the configured closing time. */
export function bookingDurationOverflowMinutes(
  time: string,
  durationMinutes: number,
  hours: BookingHours = DEFAULT_BOOKING_HOURS,
) {
  const { closingTime } = resolveBookingHours(hours);
  const startMinutes = timeToMinutes(time);
  const closingMinutes = timeToMinutes(closingTime);
  if (!Number.isFinite(startMinutes) || !Number.isFinite(durationMinutes)) return 0;
  return Math.max(0, startMinutes + durationMinutes - closingMinutes);
}

/** The portion of a booking that can be completed on its selected first day. */
export function bookingDurationForFirstDay(
  time: string,
  durationMinutes: number,
  hours: BookingHours = DEFAULT_BOOKING_HOURS,
) {
  const { closingTime } = resolveBookingHours(hours);
  const startMinutes = timeToMinutes(time);
  const closingMinutes = timeToMinutes(closingTime);
  if (!Number.isFinite(startMinutes) || !Number.isFinite(durationMinutes)) return 0;
  return Math.max(0, Math.min(durationMinutes, closingMinutes - startMinutes));
}

/** True for a valid Monday-Saturday Manila calendar date. */
export function isShopOpenDate(dateIso: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return false;
  const [year = Number.NaN, month = Number.NaN, day = Number.NaN] = dateIso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day &&
    date.getUTCDay() !== 0
  );
}

/**
 * Build the public booking grid. The configured hourly slot capacity applies
 * to both half-hour starts within that hour.
 */
export function buildBookingTimeSlots(
  config: BookingCapacityConfig[],
  hours: BookingHours = DEFAULT_BOOKING_HOURS,
): BookingTimeSlot[] {
  const { openingTime, closingTime } = resolveBookingHours(hours);
  const openingMinutes = timeToMinutes(openingTime);
  const closingMinutes = timeToMinutes(closingTime);
  return Array.from(
    { length: (closingMinutes - openingMinutes) / BOOKING_INTERVAL_MINUTES },
    (_, index) => {
      const startMinutes = openingMinutes + index * BOOKING_INTERVAL_MINUTES;
      const startTime = minutesToTime(startMinutes);
      const hourStart = minutesToTime(Math.floor(startMinutes / 60) * 60);
      const configured = config.find((slot) => slot.startTime.slice(0, 5) === startTime);
      const hourlyConfigured = config.find((slot) => slot.startTime.slice(0, 5) === hourStart);

      return {
        id: `booking-${startTime}`,
        startTime,
        endTime: minutesToTime(startMinutes + BOOKING_INTERVAL_MINUTES),
        // A configured hour covers its two half-hour starts. Do not infer a
        // capacity for hours absent from the configuration: doing so can
        // inadvertently reopen an intentionally omitted time such as lunch.
        capacity: Math.max(0, Number(configured?.capacity ?? hourlyConfigured?.capacity ?? 0)),
      };
    },
  );
}

export function intervalsOverlap(startA: number, endA: number, startB: number, endB: number) {
  return startA < endB && endA > startB;
}

export function formatDateLong(iso: string) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).toLocaleDateString("en-PH", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Current date/time parts in Asia/Manila. */
export function manilaNow() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/** Epoch ms for a Manila local date + time string. */
export function manilaTimestamp(dateIso: string, time: string) {
  return Date.parse(`${dateIso}T${time.slice(0, 5)}:00+08:00`);
}

export function addDays(dateIso: string, days: number) {
  const [y, m, d] = dateIso.split("-").map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

const RANGE_PREFIX = "RANGE:";

export function encodeBlockReason(endTime: string | null, userReason: string): string | null {
  if (!endTime) return userReason || null;
  const base = `${RANGE_PREFIX}${endTime.slice(0, 5)}`;
  return userReason ? `${base}|${userReason}` : base;
}

export function decodeBlockReason(reason: string | null): {
  endTime: string | null;
  userReason: string;
} {
  if (!reason || !reason.startsWith(RANGE_PREFIX))
    return { endTime: null, userReason: reason ?? "" };
  const rest = reason.slice(RANGE_PREFIX.length);
  const pipeIdx = rest.indexOf("|");
  if (pipeIdx === -1) return { endTime: rest, userReason: "" };
  return { endTime: rest.slice(0, 5), userReason: rest.slice(pipeIdx + 1) };
}

export const PHONE_VALIDATION_MESSAGE = "Enter a valid mobile number.";

/** Keep the mobile-number field to its local 11-digit format while the user types. */
export function sanitizePhilippineMobileInput(value: string) {
  return value.replace(/\D/g, "").slice(0, 11);
}

/** Convert a stored or pasted Philippine mobile number to its local 09XXXXXXXXX form. */
export function toLocalPhilippineMobile(value: string) {
  const digits = value.replace(/\D/g, "");
  if (/^639\d{9}$/.test(digits)) return `0${digits.slice(2)}`;
  return sanitizePhilippineMobileInput(digits);
}

/** Convert local or E.164 Philippine mobile input to the canonical value stored in the database. */
export function normalizePhilippineMobile(value: string): string | null {
  const digits = value.replace(/\D/g, "");

  if (/^639\d{9}$/.test(digits)) return `+${digits}`;

  if (/^09\d{9}$/.test(digits)) return `+63${digits.slice(1)}`;

  return null;
}

export const phoneSchema = z
  .string()
  .trim()
  .refine((value) => normalizePhilippineMobile(value) !== null, PHONE_VALIDATION_MESSAGE)
  .transform((value) => normalizePhilippineMobile(value)!);

export const REFERENCE_CODE_PATTERN = /^FRM-[A-Z0-9]{6}$/i;
export const REFERENCE_CODE_VALIDATION_MESSAGE =
  "Enter a valid reference code in the format FRM-XXXXXX.";

/** Reference codes are case-insensitive; store and query them in one canonical form. */
export function normalizeReferenceCode(value: string) {
  return value.trim().toUpperCase();
}

export function isReferenceCode(value: string) {
  return REFERENCE_CODE_PATTERN.test(normalizeReferenceCode(value));
}

/** Booking rule: the slot must start after the configured lead time (Manila). */
export function isSlotBookable(dateIso: string, time: string, minimumLeadHours = SHOP.noticeHours) {
  return manilaTimestamp(dateIso, time) - Date.now() >= minimumLeadHours * 3600 * 1000;
}

export function earliestBookableDate(minimumLeadHours = SHOP.noticeHours) {
  const now = manilaNow();
  const ts = manilaTimestamp(now.date, `${now.time}:00`);
  const cutoff = ts + minimumLeadHours * 3600 * 1000;
  return new Date(cutoff).toLocaleDateString("en-CA", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}
