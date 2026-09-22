import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/integrations/supabase/types";
import { buildPublicAvailability } from "./availability";
import {
  addDays,
  buildBookingTimeSlots,
  DEFAULT_BOOKING_HOURS,
  decodeBlockReason,
  earliestBookableDate,
  formatDateLong,
  formatTime,
  intervalsOverlap,
  bookingDurationForFirstDay,
  bookingDurationOverflowMinutes,
  isBookingStartTime,
  isBookingTimeRangeWithinHours,
  isShopOpenDate,
  isSlotBookable,
  manilaNow,
  MAX_BOOKING_SERVICE_SELECTIONS,
  normalizePhilippineMobile,
  phoneSchema,
  REFERENCE_CODE_PATTERN,
  normalizeReferenceCode,
  timeToMinutes,
} from "./shop";

type BookingRules = {
  operatingHours: {
    openingTime: string;
    closingTime: string;
  };
  minimumBookingLeadHours: number;
  maxAdvanceBookingDays: number;
  allowSameDayAppointments: boolean;
  cancellationNoticeHours: number;
  reschedulingNoticeHours: number;
};

const defaultBookingRules: BookingRules = {
  operatingHours: DEFAULT_BOOKING_HOURS,
  minimumBookingLeadHours: 48,
  maxAdvanceBookingDays: 30,
  allowSameDayAppointments: false,
  cancellationNoticeHours: 48,
  reschedulingNoticeHours: 48,
};

async function getBookingRules(): Promise<BookingRules> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("shop_settings")
      .select(
        "opening_time,closing_time,minimum_booking_lead_hours,max_advance_booking_days,allow_same_day_appointments,cancellation_notice_hours,rescheduling_notice_hours",
      )
      .eq("id", true)
      .maybeSingle();
    if (error || !data) {
      if (error) console.warn("[Booking settings] using defaults", error.message);
      return defaultBookingRules;
    }
    return {
      operatingHours: {
        openingTime: String(data.opening_time).slice(0, 5),
        closingTime: String(data.closing_time).slice(0, 5),
      },
      minimumBookingLeadHours: data.minimum_booking_lead_hours,
      maxAdvanceBookingDays: data.max_advance_booking_days,
      allowSameDayAppointments: data.allow_same_day_appointments,
      cancellationNoticeHours: data.cancellation_notice_hours,
      reschedulingNoticeHours: data.rescheduling_notice_hours,
    };
  } catch (error) {
    console.warn("[Booking settings] using defaults", error);
    return defaultBookingRules;
  }
}

function firstBookableDate(rules: BookingRules, minimumLeadHours = rules.minimumBookingLeadHours) {
  let date = earliestBookableDate(minimumLeadHours);
  if (!rules.allowSameDayAppointments && date === manilaNow().date) date = addDays(date, 1);
  return date;
}

const currentYear = new Date().getFullYear();

const motorcycleSelectionSchema = z.object({
  brand: z.string().trim().min(1).max(50),
  model: z.string().trim().min(1).max(50),
});

type ResolvedService = {
  id: string;
  name: string;
  price: number;
  durationMinutes: number;
  pricingSource: "default" | "model_override";
};

function resolveServicePricing(
  services: Array<{ id: string; name: string; price: number; duration_minutes: number | null }>,
  overrides: Array<{
    service_id: string;
    brand: string;
    model: string;
    duration_minutes: number;
    price: number;
  }>,
  motorcycle?: { brand: string; model: string },
): ResolvedService[] {
  return services.map((service) => {
    const override = motorcycle
      ? overrides.find(
          (item) =>
            item.service_id === service.id &&
            item.brand.trim().toLocaleLowerCase() === motorcycle.brand.trim().toLocaleLowerCase() &&
            item.model.trim().toLocaleLowerCase() === motorcycle.model.trim().toLocaleLowerCase(),
        )
      : undefined;
    if (override) {
      return {
        id: service.id,
        name: service.name,
        price: Number(override.price),
        durationMinutes: override.duration_minutes,
        pricingSource: "model_override",
      };
    }

    return {
      id: service.id,
      name: service.name,
      price: Number(service.price),
      durationMinutes: service.duration_minutes ?? 60,
      pricingSource: "default",
    };
  });
}

const availabilitySchema = z
  .object({
    days: z.number().int().min(7).max(90).default(45),
    serviceIds: z
      .array(z.string().uuid())
      .max(MAX_BOOKING_SERVICE_SELECTIONS)
      .refine((ids) => new Set(ids).size === ids.length, "Services must be unique")
      .default([]),
    // Administrators editing an appointment need to see the current slot as
    // available while still applying the exact same booking rules to every
    // other appointment.
    excludeAppointmentId: z.string().uuid().optional(),
    allowMultiDayContinuation: z.boolean().default(false),
    rescheduling: z.boolean().default(false),
    motorcycle: motorcycleSelectionSchema.optional(),
    rescheduleReference: z
      .string()
      .trim()
      .regex(REFERENCE_CODE_PATTERN, "Enter a valid original appointment reference.")
      .transform(normalizeReferenceCode)
      .optional(),
    reschedulePhone: phoneSchema.optional(),
  })
  .superRefine((data, context) => {
    if (Boolean(data.rescheduleReference) !== Boolean(data.reschedulePhone)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A reschedule reference and mobile number must be provided together.",
      });
    }
  });

const namePartSchema = z
  .string()
  .trim()
  .max(40)
  .regex(/^(?:[A-Za-z]+(?: [A-Za-z]+)*)?$/, "Names may contain letters and spaces only.");

const bookingSchema = z
  .object({
    firstName: namePartSchema.default(""),
    middleName: namePartSchema.default(""),
    lastName: namePartSchema.default(""),
    phone: phoneSchema,
    motoBrand: z.string().trim().min(1).max(50),
    motoModel: z.string().trim().min(1).max(50),
    motoVariant: z.string().trim().max(50).optional().or(z.literal("")),
    motoYear: z.number().int().min(1970).max(currentYear),
    plateNumber: z.string().trim().min(2).max(20),
    serviceIds: z
      .array(z.string().uuid())
      .min(1)
      .max(MAX_BOOKING_SERVICE_SELECTIONS)
      .refine((ids) => new Set(ids).size === ids.length, "Services must be unique"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
    notes: z.string().trim().max(500).optional().or(z.literal("")),
    turnstileToken: z.string().trim().max(2048).default(""),
    idempotencyKey: z.string().uuid(),
    termsAccepted: z.literal(true),
    multiDayContinuationAccepted: z.boolean().default(false),
    rescheduleReference: z
      .string()
      .trim()
      .regex(REFERENCE_CODE_PATTERN, "Enter a valid original appointment reference.")
      .optional(),
    rescheduleReason: z.string().trim().max(500).optional().or(z.literal("")),
  })
  .superRefine((data, context) => {
    if (data.rescheduleReference && !data.rescheduleReason?.trim()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rescheduleReason"],
        message: "A reason for rescheduling is required.",
      });
    }
  });

export type BookingInput = z.infer<typeof bookingSchema>;

function fullName(firstName: string, middleName: string, lastName: string) {
  return [firstName.trim(), middleName.trim(), lastName.trim()].filter(Boolean).join(" ");
}

function unavailableAvailability(from: string, to: string, error: string) {
  return {
    from,
    to,
    error,
    totalDurationMinutes: 90,
    dates: [],
    fullyBookedDates: [],
    slotsByDate: {},
  };
}

type ContinuationSegment = {
  segmentNumber: number;
  appointmentDate: string;
  startTime: string;
  bookingDurationMinutes: number;
  assignedCrewId: string;
};

type ScheduledReservation = {
  appointmentDate: string;
  startTime: string;
  bookingDurationMinutes: number;
  assignedCrewId: string | null;
};

function overlapsScheduledRange(
  startTime: string,
  durationMinutes: number,
  other: ScheduledReservation,
) {
  const start = timeToMinutes(startTime);
  const otherStart = timeToMinutes(other.startTime);
  return intervalsOverlap(
    start,
    start + durationMinutes,
    otherStart,
    otherStart + other.bookingDurationMinutes,
  );
}

function scheduleHasOverlappingBlock(
  blocks: Array<{ start_time: string | null; reason: string | null }>,
  startTime: string,
  durationMinutes: number,
) {
  const start = timeToMinutes(startTime);
  return blocks.some((block) => {
    if (!block.start_time) return true;
    const { endTime } = decodeBlockReason(block.reason);
    const blockStart = String(block.start_time).slice(0, 5);
    if (!endTime) return blockStart === startTime;
    return intervalsOverlap(
      start,
      start + durationMinutes,
      timeToMinutes(blockStart),
      timeToMinutes(endTime),
    );
  });
}

async function planContinuationSegments({
  supabaseAdmin,
  firstDate,
  remainingMinutes,
  lastAvailableDate,
  operatingHours,
  slotConfig,
}: {
  supabaseAdmin: SupabaseClient<Database>;
  firstDate: string;
  remainingMinutes: number;
  lastAvailableDate: string;
  operatingHours: BookingRules["operatingHours"];
  slotConfig: Array<{ startTime: string; capacity: number }>;
}): Promise<{ ok: true; segments: ContinuationSegment[] } | { ok: false; error: string }> {
  const from = addDays(firstDate, 1);
  if (from > lastAvailableDate) {
    return {
      ok: false,
      error: "There is not enough future shop time available to complete these services.",
    };
  }

  const [blocksRes, schedulesRes, crewRes, exceptionsRes, appointmentsRes, continuationsRes] =
    await Promise.all([
      supabaseAdmin
        .from("schedule_blocks")
        .select("block_date,start_time,reason")
        .eq("is_active", true)
        .gte("block_date", from)
        .lte("block_date", lastAvailableDate),
      supabaseAdmin
        .from("crew_schedules")
        .select("crew_id,schedule_date,start_time,end_time,is_working")
        .gte("schedule_date", from)
        .lte("schedule_date", lastAvailableDate),
      supabaseAdmin
        .from("crew_members")
        .select("id")
        .eq("is_active", true)
        .eq("is_archived", false),
      supabaseAdmin
        .from("crew_availability_exceptions")
        .select("crew_id,start_date,end_date,start_time,end_time,is_all_day")
        .lte("start_date", lastAvailableDate)
        .gte("end_date", from),
      supabaseAdmin
        .from("appointments")
        .select("appointment_date,start_time,assigned_crew_id,booking_duration_minutes")
        .eq("is_archived", false)
        .is("rescheduled_to_appointment_id", null)
        .not("status", "in", "(cancelled,rejected,no_show)")
        .gte("appointment_date", from)
        .lte("appointment_date", lastAvailableDate),
      supabaseAdmin
        .from("appointment_continuations")
        .select(
          "appointment_id,appointment_date,start_time,assigned_crew_id,booking_duration_minutes",
        )
        .gte("appointment_date", from)
        .lte("appointment_date", lastAvailableDate),
    ]);

  if (
    blocksRes.error ||
    schedulesRes.error ||
    crewRes.error ||
    exceptionsRes.error ||
    appointmentsRes.error ||
    continuationsRes.error
  ) {
    console.error("[Booking continuation] availability lookup failed", {
      blocks: blocksRes.error,
      schedules: schedulesRes.error,
      crew: crewRes.error,
      exceptions: exceptionsRes.error,
      appointments: appointmentsRes.error,
      continuations: continuationsRes.error,
    });
    return {
      ok: false,
      error: "We could not reserve the next available shop day. Please try again.",
    };
  }

  const continuationParentIds = Array.from(
    new Set((continuationsRes.data ?? []).map((continuation) => continuation.appointment_id)),
  );
  const continuationParents = continuationParentIds.length
    ? await supabaseAdmin
        .from("appointments")
        .select("id,is_archived,status,rescheduled_to_appointment_id")
        .in("id", continuationParentIds)
    : { data: [], error: null };
  if (continuationParents.error) {
    return {
      ok: false,
      error: "We could not reserve the next available shop day. Please try again.",
    };
  }

  const activeContinuationParentIds = new Set(
    (continuationParents.data ?? [])
      .filter(
        (appointment) =>
          !appointment.is_archived &&
          !appointment.rescheduled_to_appointment_id &&
          ["pending", "confirmed", "in_progress", "rescheduled"].includes(appointment.status),
      )
      .map((appointment) => appointment.id),
  );
  const reservations: ScheduledReservation[] = [
    ...(appointmentsRes.data ?? []).map((appointment) => ({
      appointmentDate: appointment.appointment_date,
      startTime: String(appointment.start_time).slice(0, 5),
      bookingDurationMinutes: appointment.booking_duration_minutes ?? 75,
      assignedCrewId: appointment.assigned_crew_id,
    })),
    ...(continuationsRes.data ?? [])
      .filter((continuation) => activeContinuationParentIds.has(continuation.appointment_id))
      .map((continuation) => ({
        appointmentDate: continuation.appointment_date,
        startTime: String(continuation.start_time).slice(0, 5),
        bookingDurationMinutes: continuation.booking_duration_minutes,
        assignedCrewId: continuation.assigned_crew_id,
      })),
  ];
  const activeCrewIds = new Set((crewRes.data ?? []).map((crew) => crew.id));
  const bookingSlots = buildBookingTimeSlots(slotConfig, operatingHours);
  const closingMinutes = timeToMinutes(operatingHours.closingTime);
  const segments: ContinuationSegment[] = [];
  let remaining = remainingMinutes;
  let cursor = from;

  while (remaining > 0 && cursor <= lastAvailableDate) {
    if (!isShopOpenDate(cursor)) {
      cursor = addDays(cursor, 1);
      continue;
    }

    const dateBlocks = (blocksRes.data ?? []).filter((block) => block.block_date === cursor);
    const schedulesByCrew = new Map(
      (schedulesRes.data ?? [])
        .filter(
          (schedule) =>
            schedule.schedule_date === cursor &&
            schedule.is_working &&
            activeCrewIds.has(schedule.crew_id) &&
            schedule.start_time &&
            schedule.end_time,
        )
        .map((schedule) => [schedule.crew_id, schedule]),
    );
    const dateExceptions = (exceptionsRes.data ?? []).filter(
      (exception) => exception.start_date <= cursor && exception.end_date >= cursor,
    );

    for (const slot of bookingSlots) {
      const slotStart = timeToMinutes(slot.startTime);
      const duration = Math.min(remaining, closingMinutes - slotStart);
      if (
        duration <= 0 ||
        slot.capacity <= 0 ||
        !isBookingTimeRangeWithinHours(slot.startTime, duration, operatingHours) ||
        scheduleHasOverlappingBlock(dateBlocks, slot.startTime, duration)
      ) {
        continue;
      }

      const overlapping = reservations.filter(
        (reservation) =>
          reservation.appointmentDate === cursor &&
          overlapsScheduledRange(slot.startTime, duration, reservation),
      );
      const occupiedCrewIds = new Set(
        overlapping.flatMap((reservation) =>
          reservation.assignedCrewId ? [reservation.assignedCrewId] : [],
        ),
      );
      const unassignedCount = overlapping.filter(
        (reservation) => !reservation.assignedCrewId,
      ).length;
      const availableCrewIds = [...schedulesByCrew.values()].flatMap((schedule) => {
        const shiftStart = timeToMinutes(String(schedule.start_time).slice(0, 5));
        const shiftEnd = timeToMinutes(String(schedule.end_time).slice(0, 5));
        if (
          slotStart < shiftStart ||
          slotStart + duration > shiftEnd ||
          occupiedCrewIds.has(schedule.crew_id)
        ) {
          return [];
        }

        const unavailable = dateExceptions.some((exception) => {
          if (exception.crew_id !== schedule.crew_id) return false;
          if (exception.is_all_day) return true;
          if (!exception.start_time || !exception.end_time) return false;
          return intervalsOverlap(
            slotStart,
            slotStart + duration,
            timeToMinutes(String(exception.start_time).slice(0, 5)),
            timeToMinutes(String(exception.end_time).slice(0, 5)),
          );
        });
        return unavailable ? [] : [schedule.crew_id];
      });

      if (Math.min(slot.capacity, availableCrewIds.length) <= unassignedCount) continue;
      const assignedCrewId = availableCrewIds[unassignedCount];
      if (!assignedCrewId) continue;

      const segment: ContinuationSegment = {
        segmentNumber: segments.length + 1,
        appointmentDate: cursor,
        startTime: slot.startTime,
        bookingDurationMinutes: duration,
        assignedCrewId,
      };
      segments.push(segment);
      reservations.push({
        appointmentDate: segment.appointmentDate,
        startTime: segment.startTime,
        bookingDurationMinutes: segment.bookingDurationMinutes,
        assignedCrewId: segment.assignedCrewId,
      });
      remaining -= duration;
      break;
    }
    cursor = addDays(cursor, 1);
  }

  return remaining === 0
    ? { ok: true, segments }
    : {
        ok: false,
        error:
          "There is not enough mechanic availability in the booking window to complete these services.",
      };
}

function availabilityErrorMessage(errors: Array<{ message: string } | null>) {
  const message = errors
    .filter((error): error is { message: string } => !!error)
    .map((error) => error.message)
    .join(" ");

  if (
    /booking_duration_minutes|appointment_services.*duration_minutes|schedule_date/i.test(message)
  ) {
    return "Booking capacity setup is incomplete. The shop needs to apply its scheduling database update.";
  }

  return "We could not load booking availability. Please try again shortly.";
}

function makeReference() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return `FRM-${out}`;
}

function getClientIp() {
  const request = getRequest();
  const platformIp =
    request?.headers.get("x-vercel-forwarded-for")?.trim() ||
    request?.headers.get("cf-connecting-ip")?.trim();
  const forwarded = request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return platformIp || forwarded || request?.headers.get("x-real-ip")?.trim() || "unknown";
}

async function hashRateLimitSubject(subject: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subject));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Persistent, per-endpoint limits. The database function serializes increments,
 * so this also works when the app runs across multiple serverless instances.
 */
type RateLimitResult = "allowed" | "limited" | "unavailable";

async function checkPublicRequestRateLimit(
  scope:
    "availability" | "booking" | "lookup" | "cancellation" | "rescheduling" | "reference_recovery",
  maxRequests: number,
  windowSeconds: number,
  subject?: string,
): Promise<RateLimitResult> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const subjects = [await hashRateLimitSubject(`ip:${getClientIp()}`)];
    if (subject) subjects.push(await hashRateLimitSubject(`subject:${subject}`));

    for (const opaqueSubject of subjects) {
      const { data, error } = await supabaseAdmin.rpc("enforce_public_rate_limit", {
        p_scope: scope,
        p_subject: opaqueSubject,
        p_limit: maxRequests,
        p_window_seconds: windowSeconds,
      });
      if (error) {
        console.error(`[Rate limit] ${scope} check failed`, error);
        return "unavailable";
      }
      if (data !== true) return "limited";
    }
    return "allowed";
  } catch (error) {
    console.error(`[Rate limit] ${scope} check failed`, error);
    return "unavailable";
  }
}

async function isTurnstileVerificationValid(token: string, idempotencyKey: string) {
  const secret = process.env["TURNSTILE_SECRET_KEY"];
  if (!secret) return true;
  if (!token) return false;

  try {
    const body = new FormData();
    body.set("secret", secret);
    body.set("response", token);
    body.set("idempotency_key", idempotencyKey);
    const ip = getClientIp();
    if (ip !== "unknown") body.set("remoteip", ip);

    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    const result = (await response.json()) as { success?: unknown; action?: unknown };
    return response.ok && result.success === true && result.action === "booking";
  } catch (error) {
    console.error("[Turnstile] booking verification failed", error);
    return false;
  }
}

/** Slot availability for a date range (Manila dates). */
export const getAvailability = createServerFn({ method: "GET" })
  .validator((input: unknown) => availabilitySchema.parse(input ?? {}))
  .handler(async ({ data }) => {
    const from = earliestBookableDate();
    const to = addDays(from, data.days);
    const supabaseModule = await import("@/integrations/supabase/client.server").catch((error) => {
      console.error("[Booking availability] Supabase configuration failed", error);
      return null;
    });
    if (!supabaseModule) {
      return unavailableAvailability(
        from,
        to,
        "Booking availability is temporarily unavailable. Please try again shortly.",
      );
    }
    const { supabaseAdmin } = supabaseModule;
    const bookingRules = await getBookingRules();
    const configuredFrom = firstBookableDate(
      bookingRules,
      data.rescheduling ? bookingRules.reschedulingNoticeHours : undefined,
    );
    const configuredTo = addDays(
      manilaNow().date,
      Math.max(0, Math.min(data.days, bookingRules.maxAdvanceBookingDays)),
    );

    const availabilityRateLimit = await checkPublicRequestRateLimit("availability", 60, 60);
    if (availabilityRateLimit === "limited") {
      return unavailableAvailability(
        configuredFrom,
        configuredTo,
        "Too many availability checks. Please try again shortly.",
      );
    }
    // Availability is read-only. A rate-limit infrastructure issue must not
    // prevent a customer from selecting a service and seeing schedules.
    if (availabilityRateLimit === "unavailable") {
      console.warn(
        "[Rate limit] availability protection unavailable; continuing with read-only lookup",
      );
    }

    let appointmentsQuery = supabaseAdmin
      .from("appointments")
      .select("appointment_date,start_time,assigned_crew_id,booking_duration_minutes")
      .eq("is_archived", false)
      .gte("appointment_date", configuredFrom)
      .lte("appointment_date", configuredTo)
      .is("rescheduled_to_appointment_id", null)
      .not("status", "in", "(cancelled,rejected,no_show)");
    if (data.excludeAppointmentId) {
      appointmentsQuery = appointmentsQuery.neq("id", data.excludeAppointmentId);
    }

    const [
      slotsRes,
      blocksRes,
      apptsRes,
      servicesRes,
      overridesRes,
      schedulesRes,
      activeCrewRes,
      exceptionsRes,
      continuationsRes,
    ] = await Promise.all([
      supabaseAdmin
        .from("time_slots")
        .select("id,start_time,end_time,capacity")
        .eq("is_active", true)
        .order("start_time"),
      supabaseAdmin
        .from("schedule_blocks")
        .select("block_date,start_time,reason")
        .eq("is_active", true)
        .gte("block_date", configuredFrom)
        .lte("block_date", configuredTo),
      appointmentsQuery,
      data.serviceIds.length > 0
        ? supabaseAdmin
            .from("services")
            .select("id,name,price,duration_minutes")
            .in("id", data.serviceIds)
            .eq("is_active", true)
            .eq("is_archived", false)
        : {
            data: [] as {
              id: string;
              name: string;
              price: number;
              duration_minutes: number | null;
            }[],
            error: null,
          },
      data.serviceIds.length > 0
        ? supabaseAdmin
            .from("service_model_overrides")
            .select("service_id,brand,model,duration_minutes,price")
            .in("service_id", data.serviceIds)
        : { data: [], error: null },
      supabaseAdmin
        .from("crew_schedules")
        .select("*")
        .gte("schedule_date", configuredFrom)
        .lte("schedule_date", configuredTo),
      supabaseAdmin
        .from("crew_members")
        .select("id")
        .eq("is_active", true)
        .eq("is_archived", false),
      supabaseAdmin
        .from("crew_availability_exceptions")
        .select("*")
        .gte("end_date", configuredFrom)
        .lte("start_date", configuredTo),
      supabaseAdmin
        .from("appointment_continuations")
        .select(
          "appointment_id,appointment_date,start_time,assigned_crew_id,booking_duration_minutes",
        )
        .gte("appointment_date", configuredFrom)
        .lte("appointment_date", configuredTo),
    ]);

    if (
      slotsRes.error ||
      blocksRes.error ||
      apptsRes.error ||
      servicesRes.error ||
      overridesRes.error ||
      schedulesRes.error ||
      activeCrewRes.error ||
      exceptionsRes.error ||
      continuationsRes.error
    ) {
      const errors = [
        slotsRes.error,
        blocksRes.error,
        apptsRes.error,
        servicesRes.error,
        overridesRes.error,
        schedulesRes.error,
        activeCrewRes.error,
        exceptionsRes.error,
        continuationsRes.error,
      ];
      console.error("[Booking availability] database query failed", errors);
      return unavailableAvailability(
        configuredFrom,
        configuredTo,
        availabilityErrorMessage(errors),
      );
    }

    if (
      data.serviceIds.length > 0 &&
      (servicesRes.data?.length ?? 0) !== new Set(data.serviceIds).size
    ) {
      return unavailableAvailability(
        configuredFrom,
        configuredTo,
        "One or more selected services are no longer available. Please choose a different service.",
      );
    }

    let motorcycle: { brand: string; model: string } | undefined;
    if (data.rescheduleReference && data.reschedulePhone) {
      const original = await findAppointment(data.rescheduleReference, data.reschedulePhone);
      if (!original) {
        return unavailableAvailability(
          configuredFrom,
          configuredTo,
          "We could not verify the original appointment. Please return to the Appointment Tracker and try again.",
        );
      }

      motorcycle = { brand: original.moto_brand, model: original.moto_model };
    }

    if (!motorcycle && data.motorcycle) {
      const motorcycleRecord = await supabaseAdmin
        .from("motorcycle_catalog")
        .select("brand,model")
        .eq("brand", data.motorcycle.brand)
        .eq("model", data.motorcycle.model)
        .eq("is_active", true)
        .eq("is_archived", false)
        .maybeSingle();
      if (motorcycleRecord.error || !motorcycleRecord.data) {
        return unavailableAvailability(
          configuredFrom,
          configuredTo,
          "Select a valid motorcycle model from the Motorcycle Catalog.",
        );
      }
      motorcycle = { ...data.motorcycle };
    }

    // Reserve one 15-minute arrival buffer and one 15-minute post-service
    // buffer around the complete selected-service duration.
    const resolvedServices = resolveServicePricing(
      servicesRes.data ?? [],
      overridesRes.data ?? [],
      motorcycle,
    );
    const totalDuration = resolvedServices.reduce(
      (sum, service) => sum + service.durationMinutes,
      30,
    );

    const assignments: {
      date: string;
      startTime: string;
      durationMinutes: number;
      crewId: string | null;
    }[] = [];
    for (const a of apptsRes.data ?? []) {
      assignments.push({
        date: a.appointment_date,
        startTime: String(a.start_time).slice(0, 5),
        durationMinutes: a.booking_duration_minutes ?? 75,
        crewId: a.assigned_crew_id,
      });
    }
    const continuationParentIds = Array.from(
      new Set((continuationsRes.data ?? []).map((continuation) => continuation.appointment_id)),
    );
    if (continuationParentIds.length > 0) {
      const continuationParents = await supabaseAdmin
        .from("appointments")
        .select("id,is_archived,status,rescheduled_to_appointment_id")
        .in("id", continuationParentIds);
      if (continuationParents.error) {
        return unavailableAvailability(
          configuredFrom,
          configuredTo,
          "Booking availability is temporarily unavailable. Please try again shortly.",
        );
      }
      const activeContinuationParents = new Set(
        (continuationParents.data ?? [])
          .filter(
            (appointment) =>
              !appointment.is_archived &&
              !appointment.rescheduled_to_appointment_id &&
              ["pending", "confirmed", "in_progress", "rescheduled"].includes(appointment.status),
          )
          .map((appointment) => appointment.id),
      );
      for (const continuation of continuationsRes.data ?? []) {
        if (!activeContinuationParents.has(continuation.appointment_id)) continue;
        assignments.push({
          date: continuation.appointment_date,
          startTime: String(continuation.start_time).slice(0, 5),
          durationMinutes: continuation.booking_duration_minutes,
          crewId: continuation.assigned_crew_id,
        });
      }
    }

    const capacityConfig = (slotsRes.data ?? []).map((slot) => ({
      startTime: String(slot.start_time).slice(0, 5),
      capacity: slot.capacity,
    }));

    const publicAvailability = buildPublicAvailability({
      from: configuredFrom,
      to: configuredTo,
      minimumBookingLeadHours: data.rescheduling
        ? bookingRules.reschedulingNoticeHours
        : bookingRules.minimumBookingLeadHours,
      totalDurationMinutes: totalDuration || 90,
      allowMultiDayContinuation: data.allowMultiDayContinuation && !data.rescheduling,
      slots: buildBookingTimeSlots(capacityConfig, bookingRules.operatingHours),
      operatingHours: bookingRules.operatingHours,
      blocks: (blocksRes.data ?? []).map((b) => {
        const { endTime, userReason } = decodeBlockReason(b.reason);
        return {
          date: b.block_date,
          startTime: b.start_time ? String(b.start_time).slice(0, 5) : null,
          endTime,
          reason: userReason || null,
        };
      }),
      assignments,
      schedules: (schedulesRes.data ?? []).filter((schedule) =>
        (activeCrewRes.data ?? []).some((crew) => crew.id === schedule.crew_id),
      ),
      exceptions: exceptionsRes.data ?? [],
    });
    return {
      ...publicAvailability,
      operatingHours: bookingRules.operatingHours,
      serviceEstimates: resolvedServices,
    };
  });

export const createBooking = createServerFn({ method: "POST" })
  .validator((input: unknown) => bookingSchema.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const bookingRules = await getBookingRules();
    const customerName = fullName(data.firstName, data.middleName, data.lastName);

    if (!data.rescheduleReference && !data.firstName.trim()) {
      return { ok: false as const, error: "Enter the customer's first name." };
    }
    if (!data.rescheduleReference && !data.lastName.trim()) {
      return { ok: false as const, error: "Enter the customer's last name." };
    }

    // A retry after a lost response must return the original reservation instead
    // of consuming another slot or requiring a previously used challenge token.
    const existingRequest = await supabaseAdmin
      .from("appointments")
      .select("reference_code,total_estimate")
      .eq("booking_request_id", data.idempotencyKey)
      .maybeSingle();
    if (existingRequest.error) {
      return {
        ok: false as const,
        error: "We could not verify this booking request. Please try again.",
      };
    }
    if (existingRequest.data) {
      return {
        ok: true as const,
        reference: existingRequest.data.reference_code,
        total: Number(existingRequest.data.total_estimate),
      };
    }

    let rescheduledFrom: {
      id: string;
      reference_code: string;
      total_estimate: number;
    } | null = null;
    if (data.rescheduleReference) {
      const original = await findAppointment(data.rescheduleReference, data.phone);
      if (!original) {
        return {
          ok: false as const,
          error: "We could not verify the original appointment. Please look it up again.",
        };
      }
      if (original.rescheduled_to_appointment_id) {
        return {
          ok: false as const,
          error: "This appointment has already been rescheduled.",
        };
      }
      if (original.reschedule_count >= 3) {
        return {
          ok: false as const,
          error: "This appointment has reached the maximum of 3 reschedules.",
        };
      }
      if (!["pending", "confirmed"].includes(original.status)) {
        return {
          ok: false as const,
          error: "This appointment can no longer be rescheduled online. Please call the shop.",
        };
      }
      if (original.pending_reschedule_request_id) {
        // The first request may have reached the database but lost its response.
        // Always return its reserved code, even if a browser retry has a new key.
        if (original.pending_reschedule_reference_code) {
          return {
            ok: true as const,
            reference: original.pending_reschedule_reference_code,
            total: Number(original.total_estimate),
            rescheduleRequested: true as const,
          };
        }

        // Recover a legacy request created before references were reserved at
        // submission. Reuse the server-stored request and schedule details so
        // the new RPC can reserve its missing linked-booking reference safely.
        if (
          !original.pending_reschedule_date ||
          !original.pending_reschedule_start_time ||
          !original.pending_reschedule_reason
        ) {
          return {
            ok: false as const,
            error:
              "A reschedule request is awaiting review. Please contact the shop to complete it.",
          };
        }
        data = {
          ...data,
          idempotencyKey: original.pending_reschedule_request_id,
          date: original.pending_reschedule_date,
          startTime: String(original.pending_reschedule_start_time).slice(0, 5),
          rescheduleReason: original.pending_reschedule_reason,
        };
      }
      if (
        !isSlotBookable(
          original.appointment_date,
          String(original.start_time).slice(0, 5),
          bookingRules.reschedulingNoticeHours,
        )
      ) {
        return {
          ok: false as const,
          error: `Rescheduling needs ${bookingRules.reschedulingNoticeHours} hours notice. Please call the shop instead.`,
        };
      }
      if (data.date === original.appointment_date) {
        return {
          ok: false as const,
          error: "Choose a date different from your current appointment date.",
        };
      }

      const originalServices = (original.appointment_services ?? []).flatMap((service) =>
        service.service_id ? [service.service_id] : [],
      );
      if (originalServices.length === 0) {
        return {
          ok: false as const,
          error:
            "The original services are unavailable for online rescheduling. Please call the shop.",
        };
      }

      // Personal, motorcycle, and service data always comes from the original
      // server-side record. Client-supplied copies cannot be used to alter it.
      data = {
        ...data,
        phone: original.phone,
        motoBrand: original.moto_brand,
        motoModel: original.moto_model,
        motoVariant: original.moto_variant ?? "",
        motoYear: original.moto_year ?? new Date().getFullYear(),
        plateNumber: original.plate_number,
        serviceIds: originalServices,
        notes: original.notes ?? "",
      };
      rescheduledFrom = {
        id: original.id,
        reference_code: original.reference_code,
        total_estimate: Number(original.total_estimate),
      };
    }

    const bookingRateLimit = await checkPublicRequestRateLimit("booking", 5, 15 * 60, data.phone);
    if (bookingRateLimit !== "allowed") {
      return {
        ok: false as const,
        error:
          bookingRateLimit === "limited"
            ? "Too many booking attempts. Please wait a few minutes before trying again."
            : "Booking protection is temporarily unavailable. Please try again shortly.",
      };
    }

    if (!(await isTurnstileVerificationValid(data.turnstileToken, data.idempotencyKey))) {
      return {
        ok: false as const,
        error: "Security verification failed. Please complete the challenge and try again.",
      };
    }

    const startTime = data.startTime.slice(0, 5);
    const slotStartMin = timeToMinutes(startTime);

    const isBlocked = await supabaseAdmin
      .from("blocked_numbers")
      .select("id")
      .ilike("phone", data.phone)
      .eq("is_archived", false)
      .maybeSingle();
    if (isBlocked.data) {
      return {
        ok: false as const,
        error:
          "This number has been blocked from booking online due to previous violations. Please contact the shop directly.",
      };
    }

    if (!isBookingStartTime(startTime, bookingRules.operatingHours)) {
      return {
        ok: false as const,
        error: `Choose a booking start time from ${formatTime(bookingRules.operatingHours.openingTime)} to ${formatTime(bookingRules.operatingHours.closingTime)} in 30-minute intervals.`,
      };
    }

    if (!isShopOpenDate(data.date)) {
      return {
        ok: false as const,
        error: "Bookings are available Monday through Saturday only.",
      };
    }

    const firstAvailableDate = firstBookableDate(
      bookingRules,
      rescheduledFrom ? bookingRules.reschedulingNoticeHours : undefined,
    );
    const lastAvailableDate = addDays(manilaNow().date, bookingRules.maxAdvanceBookingDays);
    if (
      data.date < firstAvailableDate ||
      !isSlotBookable(
        data.date,
        startTime,
        rescheduledFrom
          ? bookingRules.reschedulingNoticeHours
          : bookingRules.minimumBookingLeadHours,
      )
    ) {
      return {
        ok: false as const,
        error: "This slot is no longer bookable. Please select a later time.",
      };
    }
    if (data.date > lastAvailableDate) {
      return {
        ok: false as const,
        error: `Bookings can be made up to ${bookingRules.maxAdvanceBookingDays} days in advance.`,
      };
    }

    const slotConfigRes = await supabaseAdmin
      .from("time_slots")
      .select("start_time,capacity")
      .eq("is_active", true);
    if (slotConfigRes.error) {
      return { ok: false as const, error: "We could not verify that time slot. Please try again." };
    }
    const slotConfig = (slotConfigRes.data ?? []).map((configuredSlot) => ({
      startTime: String(configuredSlot.start_time).slice(0, 5),
      capacity: configuredSlot.capacity,
    }));
    const slot = buildBookingTimeSlots(slotConfig, bookingRules.operatingHours).find(
      (configuredSlot) => configuredSlot.startTime === startTime,
    );
    if (!slot || slot.capacity <= 0)
      return { ok: false as const, error: "That time slot is not available." };

    // Resolve every selected service using its most-specific rule: exact model
    // override, then the service's default price and duration.
    const services = await supabaseAdmin
      .from("services")
      .select("id,name,price,duration_minutes")
      .in("id", data.serviceIds)
      .eq("is_active", true)
      .eq("is_archived", false);
    if (
      services.error ||
      !services.data?.length ||
      services.data.length !== data.serviceIds.length
    ) {
      return { ok: false as const, error: "Please select available services and try again." };
    }

    // The catalog is the source of truth for customer-selectable motorcycles.
    // Validate again here so a stale page or altered request cannot book an
    // inactive or archived model after the customer has reached checkout.
    if (!rescheduledFrom) {
      const motorcycleRecord = await supabaseAdmin
        .from("motorcycle_catalog")
        .select("id")
        .eq("brand", data.motoBrand)
        .eq("model", data.motoModel)
        .eq("is_active", true)
        .eq("is_archived", false)
        .maybeSingle();
      if (motorcycleRecord.error || !motorcycleRecord.data) {
        return {
          ok: false as const,
          error: "Please select an available motorcycle from the Motorcycle Catalog.",
        };
      }
    }

    const overrides = await supabaseAdmin
      .from("service_model_overrides")
      .select("service_id,brand,model,duration_minutes,price")
      .in("service_id", data.serviceIds);
    if (overrides.error) {
      console.error("[Booking] model override lookup failed", {
        overrides: overrides.error.message,
      });
      return {
        ok: false as const,
        error: "We could not calculate the selected service details. Please try again.",
      };
    }

    // Each selected service uses the matching brand-and-model override when it
    // exists; otherwise its service-level default price and duration apply.
    const resolvedServices = resolveServicePricing(services.data, overrides.data ?? [], {
      brand: data.motoBrand,
      model: data.motoModel,
    });
    const totalDuration = resolvedServices.reduce(
      (sum, service) => sum + service.durationMinutes,
      30,
    );

    const overflowMinutes = bookingDurationOverflowMinutes(
      startTime,
      totalDuration,
      bookingRules.operatingHours,
    );
    const needsContinuation =
      !rescheduledFrom && data.serviceIds.length > 1 && overflowMinutes > 30;
    if (overflowMinutes > 0 && !needsContinuation) {
      return {
        ok: false as const,
        error:
          "The selected services do not fit within the shop's operating hours. Please choose an earlier time.",
      };
    }
    if (needsContinuation && !data.multiDayContinuationAccepted) {
      return {
        ok: false as const,
        error: "Please confirm the multi-day service before continuing.",
      };
    }
    const firstDayDuration = needsContinuation
      ? bookingDurationForFirstDay(startTime, totalDuration, bookingRules.operatingHours)
      : totalDuration;
    if (
      firstDayDuration <= 0 ||
      !isBookingTimeRangeWithinHours(startTime, firstDayDuration, bookingRules.operatingHours)
    ) {
      return {
        ok: false as const,
        error:
          "The selected services do not fit within the shop's operating hours. Please choose an earlier time.",
      };
    }

    const blocked = await supabaseAdmin
      .from("schedule_blocks")
      .select("id,start_time,reason")
      .eq("block_date", data.date)
      .eq("is_active", true);
    if (blocked.error) {
      return {
        ok: false as const,
        error: "We could not verify the shop schedule. Please try again.",
      };
    }
    if (
      (blocked.data ?? []).some((b) => {
        if (!b.start_time) return true; // whole-day block
        const { endTime } = decodeBlockReason(b.reason);
        const bs = String(b.start_time).slice(0, 5);
        // Older single-slot blocks have no RANGE marker. They block their
        // exact start time; treating them as a zero-length range lets a final
        // booking bypass a slot that public availability correctly hides.
        if (!endTime) return bs === startTime;
        const bsMin = parseInt(bs.slice(0, 2)) * 60 + parseInt(bs.slice(3, 5));
        const beMin = parseInt(endTime.slice(0, 2)) * 60 + parseInt(endTime.slice(3, 5));
        // Overlap: the first-day reservation overlaps a blocked time range.
        return slotStartMin < beMin && slotStartMin + firstDayDuration > bsMin;
      })
    ) {
      return {
        ok: false as const,
        error: "The shop is closed for that schedule. Please pick another one.",
      };
    }

    // 2. Only active mechanics explicitly assigned to this date can be booked.
    //    There is intentionally no fallback to every active crew member.
    const [schedulesRes, activeCrewRes] = await Promise.all([
      supabaseAdmin
        .from("crew_schedules")
        .select("*")
        .eq("schedule_date", data.date)
        .order("crew_id"),
      supabaseAdmin
        .from("crew_members")
        .select("id")
        .eq("is_active", true)
        .eq("is_archived", false),
    ]);
    if (schedulesRes.error || activeCrewRes.error) {
      return {
        ok: false as const,
        error: "We could not verify mechanic availability. Please try again.",
      };
    }

    const activeCrewIds = new Set((activeCrewRes.data ?? []).map((crew) => crew.id));
    const effectiveSchedules = Array.from(
      new Map(
        (schedulesRes.data ?? [])
          .filter((schedule) => schedule.is_working && activeCrewIds.has(schedule.crew_id))
          .map((schedule) => [schedule.crew_id, schedule]),
      ).values(),
    );

    if (!effectiveSchedules.length) {
      return { ok: false as const, error: "No mechanics are scheduled to work on that day." };
    }

    // 3. Get availability exceptions for that date
    const exceptionsRes = await supabaseAdmin
      .from("crew_availability_exceptions")
      .select("*")
      .lte("start_date", data.date)
      .gte("end_date", data.date);
    if (exceptionsRes.error) {
      return {
        ok: false as const,
        error: "We could not verify mechanic availability. Please try again.",
      };
    }

    // 4. Check each mechanic for availability
    const availableMechanics: string[] = [];
    const [existingApptsRes, existingContinuationsRes] = await Promise.all([
      supabaseAdmin
        .from("appointments")
        .select("assigned_crew_id,start_time,booking_duration_minutes")
        .eq("appointment_date", data.date)
        .eq("is_archived", false)
        .is("rescheduled_to_appointment_id", null)
        .not("status", "in", "(cancelled,rejected,no_show)"),
      supabaseAdmin
        .from("appointment_continuations")
        .select("appointment_id,assigned_crew_id,start_time,booking_duration_minutes")
        .eq("appointment_date", data.date),
    ]);
    if (existingApptsRes.error || existingContinuationsRes.error) {
      return {
        ok: false as const,
        error: "We could not verify mechanic availability. Please try again.",
      };
    }

    const slotEndMin = slotStartMin + firstDayDuration;
    const continuationParentIds = Array.from(
      new Set(
        (existingContinuationsRes.data ?? []).map((continuation) => continuation.appointment_id),
      ),
    );
    const continuationParents = continuationParentIds.length
      ? await supabaseAdmin
          .from("appointments")
          .select("id,is_archived,status,rescheduled_to_appointment_id")
          .in("id", continuationParentIds)
      : { data: [], error: null };
    if (continuationParents.error) {
      return {
        ok: false as const,
        error: "We could not verify mechanic availability. Please try again.",
      };
    }
    const activeContinuationParentIds = new Set(
      (continuationParents.data ?? [])
        .filter(
          (appointment) =>
            !appointment.is_archived &&
            !appointment.rescheduled_to_appointment_id &&
            ["pending", "confirmed", "in_progress", "rescheduled"].includes(appointment.status),
        )
        .map((appointment) => appointment.id),
    );
    const existingReservations = [
      ...(existingApptsRes.data ?? []),
      ...(existingContinuationsRes.data ?? [])
        .filter((continuation) => activeContinuationParentIds.has(continuation.appointment_id))
        .map((continuation) => ({
          assigned_crew_id: continuation.assigned_crew_id,
          start_time: continuation.start_time,
          booking_duration_minutes: continuation.booking_duration_minutes,
        })),
    ];
    const overlappingAppointments = existingReservations.filter((appointment) => {
      const appointmentStartMin = timeToMinutes(String(appointment.start_time).slice(0, 5));
      return intervalsOverlap(
        slotStartMin,
        slotEndMin,
        appointmentStartMin,
        appointmentStartMin + (appointment.booking_duration_minutes ?? 75),
      );
    });
    const occupiedCrewIds = new Set(
      overlappingAppointments.flatMap((appointment) =>
        appointment.assigned_crew_id ? [appointment.assigned_crew_id] : [],
      ),
    );
    const unassignedAppointments = overlappingAppointments.filter(
      (appointment) => !appointment.assigned_crew_id,
    ).length;

    for (const sched of effectiveSchedules) {
      // Check shift covers the slot
      const shiftStart = String(sched.start_time).slice(0, 5);
      const shiftEnd = String(sched.end_time).slice(0, 5);
      const shiftStartMin =
        parseInt(shiftStart.slice(0, 2)) * 60 + parseInt(shiftStart.slice(3, 5));
      const shiftEndMin = parseInt(shiftEnd.slice(0, 2)) * 60 + parseInt(shiftEnd.slice(3, 5));

      if (slotStartMin < shiftStartMin || slotEndMin > shiftEndMin) continue; // Outside shift

      // Check exceptions
      const hasException = (exceptionsRes.data ?? []).some((e) => {
        if (e.crew_id !== sched.crew_id) return false;
        if (e.is_all_day) return true;
        if (e.start_time && e.end_time) {
          const excStart = String(e.start_time).slice(0, 5);
          const excEnd = String(e.end_time).slice(0, 5);
          const excStartMin = parseInt(excStart.slice(0, 2)) * 60 + parseInt(excStart.slice(3, 5));
          const excEndMin = parseInt(excEnd.slice(0, 2)) * 60 + parseInt(excEnd.slice(3, 5));
          // Check if the slot overlaps with the exception window
          if (slotStartMin < excEndMin && slotEndMin > excStartMin) return true;
        }
        return false;
      });

      if (hasException) continue;

      if (occupiedCrewIds.has(sched.crew_id)) continue;

      availableMechanics.push(sched.crew_id);
    }

    const remainingCapacity =
      Math.min(slot.capacity, availableMechanics.length) - unassignedAppointments;
    if (remainingCapacity <= 0) {
      return {
        ok: false as const,
        error: "No mechanic is available at that time. Please pick another slot.",
      };
    }

    // 5. Auto-assign an available mechanic, reserving capacity for legacy
    //    appointments that have not yet been assigned to a crew member.
    const assignedMechanicId = availableMechanics[unassignedAppointments] ?? null;

    const total = resolvedServices.reduce((sum, service) => sum + service.price, 0);

    const continuationPlan = needsContinuation
      ? await planContinuationSegments({
          supabaseAdmin,
          firstDate: data.date,
          remainingMinutes: totalDuration - firstDayDuration,
          lastAvailableDate,
          operatingHours: bookingRules.operatingHours,
          slotConfig,
        })
      : { ok: true as const, segments: [] as ContinuationSegment[] };
    if (!continuationPlan.ok) {
      return { ok: false as const, error: continuationPlan.error };
    }

    if (rescheduledFrom) {
      const request = await supabaseAdmin.rpc("submit_reschedule_request", {
        p_appointment_id: rescheduledFrom.id,
        p_request_id: data.idempotencyKey,
        p_appointment_date: data.date,
        p_start_time: `${startTime}:00`,
        p_reason:
          data.rescheduleReason?.trim() || "Customer requested a new appointment date and time.",
      });

      if (request.error) {
        console.error("[Rescheduling] request write failed", {
          code: request.error.code,
          message: request.error.message,
          details: request.error.details,
        });
        if (
          /PGRST202|submit_reschedule_request|function .* does not exist/i.test(
            request.error.message,
          )
        ) {
          return {
            ok: false as const,
            error: "Rescheduling setup is incomplete. The shop needs to apply its database update.",
          };
        }
        return {
          ok: false as const,
          error:
            request.error.message ||
            "We could not submit your reschedule request. Please try again.",
        };
      }

      const reservedReference = await supabaseAdmin
        .from("appointments")
        .select("pending_reschedule_reference_code")
        .eq("id", rescheduledFrom.id)
        .maybeSingle();
      if (reservedReference.error || !reservedReference.data?.pending_reschedule_reference_code) {
        return {
          ok: false as const,
          error:
            "Your reschedule request was saved, but we could not prepare its new reference. Please try again.",
        };
      }

      return {
        ok: true as const,
        reference: reservedReference.data.pending_reschedule_reference_code,
        total: rescheduledFrom.total_estimate,
        rescheduleRequested: true as const,
      };
    }

    let reference = makeReference();
    for (let attempt = 0; attempt < 4; attempt++) {
      const existing = await supabaseAdmin
        .from("appointments")
        .select("id")
        .or(`reference_code.eq.${reference},pending_reschedule_reference_code.eq.${reference}`)
        .maybeSingle();
      if (!existing.data) break;
      reference = makeReference();
    }

    const atomicInput = {
      p_reference_code: reference,
      p_booking_request_id: data.idempotencyKey,
      p_customer_name: customerName,
      p_phone: data.phone,
      p_moto_brand: data.motoBrand,
      p_moto_model: data.motoModel,
      p_moto_variant: data.motoVariant || null,
      p_moto_year: data.motoYear,
      p_plate_number: data.plateNumber.toUpperCase(),
      p_appointment_date: data.date,
      p_start_time: `${startTime}:00`,
      p_notes: data.notes || null,
      p_total_estimate: total,
      p_booking_duration_minutes: firstDayDuration,
      p_assigned_crew_id: assignedMechanicId,
      p_services: resolvedServices.map((service) => ({
        service_id: service.id,
        service_name: service.name,
        price: service.price,
        duration_minutes: service.durationMinutes,
      })),
      p_continuation_segments: continuationPlan.segments.map((segment) => ({
        segment_number: segment.segmentNumber,
        appointment_date: segment.appointmentDate,
        start_time: `${segment.startTime}:00`,
        booking_duration_minutes: segment.bookingDurationMinutes,
        assigned_crew_id: segment.assignedCrewId,
      })),
      p_notification_title: rescheduledFrom
        ? `Rescheduled appointment ${reference}`
        : `New booking ${reference}`,
      p_notification_message: `${customerName} ${rescheduledFrom ? "rescheduled" : "booked"} ${resolvedServices.map((service) => service.name).join(", ")} on ${data.date}.${continuationPlan.segments.length ? ` Continued across ${continuationPlan.segments.length + 1} shop days.` : ""}`,
      p_first_name: data.firstName.trim(),
      p_middle_name: data.middleName.trim(),
      p_last_name: data.lastName.trim(),
    };
    const inserted = await supabaseAdmin.rpc("create_booking_atomic", atomicInput);

    if (inserted.error?.code === "23P01") {
      return {
        ok: false as const,
        error: "That time was just booked. Please choose another available slot.",
      };
    }

    if (
      inserted.error?.code === "23505" &&
      /already have an appointment for/i.test(inserted.error.message)
    ) {
      return {
        ok: false as const,
        error: inserted.error.message,
      };
    }

    if (inserted.error) {
      console.error("[Booking] atomic database write failed", {
        code: inserted.error.code,
        message: inserted.error.message,
        details: inserted.error.details,
        hint: inserted.error.hint,
      });
      if (
        /PGRST202|create_(re)?scheduled_booking_atomic|function .* does not exist/i.test(
          inserted.error.message,
        )
      ) {
        return {
          ok: false as const,
          error:
            "Booking setup is incomplete. The shop needs to apply its booking database update.",
        };
      }
      return { ok: false as const, error: "We could not save your booking. Please try again." };
    }

    if (!inserted.data) {
      console.error("[Booking] atomic database write returned no result");
      return { ok: false as const, error: "We could not save your booking. Please try again." };
    }

    return {
      ok: true as const,
      reference: inserted.data[0]?.reference_code ?? reference,
      total,
      continuationSegments: continuationPlan.segments.map((segment) => ({
        date: segment.appointmentDate,
        startTime: segment.startTime,
        durationMinutes: segment.bookingDurationMinutes,
      })),
    };
  });

const lookupSchema = z.object({
  reference: z
    .string()
    .trim()
    .regex(REFERENCE_CODE_PATTERN, "Enter a valid reference code in the format FRM-XXXXXX.")
    .transform(normalizeReferenceCode),
  phone: phoneSchema,
});

const referenceRecoverySchema = z.object({
  lastName: namePartSchema.min(1, "Enter your last name."),
  firstName: namePartSchema.min(1, "Enter your first name."),
  phone: phoneSchema,
});

function normalizedName(value: string | null | undefined) {
  return value?.trim().replace(/\s+/g, " ").toLocaleLowerCase() ?? "";
}

function appointmentMatchesRecoveryName(
  appointment: { first_name: string | null; last_name: string | null; customer_name: string },
  firstName: string,
  lastName: string,
) {
  const normalizedFirstName = normalizedName(firstName);
  const normalizedLastName = normalizedName(lastName);
  const storedFirstName = normalizedName(appointment.first_name);
  const storedLastName = normalizedName(appointment.last_name);
  if (storedFirstName && storedLastName) {
    return storedFirstName === normalizedFirstName && storedLastName === normalizedLastName;
  }

  // Appointments created before separate name fields existed retain a full
  // customer name. Accept a matching first/last pair while allowing its middle
  // name to remain optional in the recovery form.
  const customerName = normalizedName(appointment.customer_name);
  return (
    customerName === `${normalizedFirstName} ${normalizedLastName}` ||
    (customerName.startsWith(`${normalizedFirstName} `) &&
      customerName.endsWith(` ${normalizedLastName}`))
  );
}

/** Recover only reference codes after a rate-limited ownership verification. */
export const recoverAppointmentReferences = createServerFn({ method: "POST" })
  .validator((input: unknown) => referenceRecoverySchema.parse(input))
  .handler(async ({ data }) => {
    const rateLimit = await checkPublicRequestRateLimit(
      "reference_recovery",
      5,
      15 * 60,
      data.phone,
    );
    if (rateLimit !== "allowed") {
      return {
        ok: false as const,
        error:
          rateLimit === "limited"
            ? "Too many recovery attempts. Please wait a few minutes before trying again."
            : "Reference recovery is temporarily unavailable. Please try again shortly.",
      };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: appointments, error } = await supabaseAdmin
      .from("appointments")
      .select("reference_code,first_name,last_name,customer_name")
      .eq("phone", data.phone)
      .eq("is_archived", false)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) {
      console.error("[Reference recovery] lookup failed", {
        code: error.code,
        message: error.message,
      });
      return {
        ok: false as const,
        error: "Reference recovery is temporarily unavailable. Please try again shortly.",
      };
    }

    const references = Array.from(
      new Set(
        (appointments ?? [])
          .filter((appointment) =>
            appointmentMatchesRecoveryName(appointment, data.firstName, data.lastName),
          )
          .map((appointment) => appointment.reference_code),
      ),
    );
    if (references.length === 0) {
      return {
        ok: false as const,
        error: "No appointment was found for that name and mobile number.",
      };
    }

    return { ok: true as const, references };
  });

async function findAppointment(reference: string, phone: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const primaryLookup = await supabaseAdmin
    .from("appointments")
    .select(
      "id,reference_code,customer_name,first_name,middle_name,last_name,phone,moto_brand,moto_model,moto_variant,moto_year,plate_number,appointment_date,start_time,status,notes,total_estimate,created_at,rescheduled_from_appointment_id,rescheduled_to_appointment_id,reschedule_count,last_reschedule_rejected_at,last_reschedule_rejection_message,pending_reschedule_request_id,pending_reschedule_date,pending_reschedule_start_time,pending_reschedule_reason,pending_reschedule_reference_code,appointment_services(service_id,service_name,price)",
    )
    // Legacy records may have been written with lower-case reference codes.
    // Input is validated before this query, so it cannot introduce LIKE wildcards.
    .ilike("reference_code", normalizeReferenceCode(reference))
    .maybeSingle();

  // Keep the appointment tracker usable during a rolling deployment: the
  // linked-booking column is introduced by the reschedule migration and may
  // not be present in the database while the application code is already live.
  const requiresLegacyLookup =
    primaryLookup.error &&
    ["42703", "PGRST204"].includes(primaryLookup.error.code) &&
    primaryLookup.error.message.includes("pending_reschedule_reference_code");
  const legacyLookup = requiresLegacyLookup
    ? await supabaseAdmin
        .from("appointments")
        .select(
          "id,reference_code,customer_name,first_name,middle_name,last_name,phone,moto_brand,moto_model,moto_variant,moto_year,plate_number,appointment_date,start_time,status,notes,total_estimate,created_at,rescheduled_from_appointment_id,rescheduled_to_appointment_id,reschedule_count,last_reschedule_rejected_at,last_reschedule_rejection_message,pending_reschedule_request_id,pending_reschedule_date,pending_reschedule_start_time,pending_reschedule_reason,appointment_services(service_id,service_name,price)",
        )
        .ilike("reference_code", normalizeReferenceCode(reference))
        .maybeSingle()
    : null;
  const appointment = legacyLookup?.data
    ? { ...legacyLookup.data, pending_reschedule_reference_code: null }
    : primaryLookup.data;
  if (!appointment) return null;

  // Public input is normalized to E.164 by `lookupSchema`. Normalize the
  // stored value too so appointments created before phone normalization (for
  // example `0917…` or `+63 917…`) remain available to their owner.
  const storedPhone = normalizePhilippineMobile(appointment.phone);
  if (storedPhone !== phone) return null;

  return appointment;
}

export const getRescheduleDetails = createServerFn({ method: "POST" })
  .validator((input: unknown) => lookupSchema.parse(input))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const rateLimit = await checkPublicRequestRateLimit("rescheduling", 5, 15 * 60, data.phone);
    if (rateLimit !== "allowed") {
      return {
        ok: false as const,
        error:
          rateLimit === "limited"
            ? "Too many reschedule attempts. Please wait a few minutes before trying again."
            : "Appointment rescheduling is temporarily unavailable. Please try again shortly.",
      };
    }

    const appt = await findAppointment(data.reference, data.phone);
    if (!appt) {
      return {
        ok: false as const,
        error: "No appointment found for that reference code and mobile number.",
      };
    }
    if (appt.rescheduled_to_appointment_id) {
      return {
        ok: false as const,
        error: "This appointment has already been rescheduled. Please use the new reference.",
      };
    }
    if (appt.pending_reschedule_request_id) {
      return {
        ok: false as const,
        error: "A reschedule request for this appointment is already awaiting the shop's review.",
      };
    }
    // A completed reschedule retains the original appointment for history,
    // but only pending and confirmed appointments are valid reschedule
    // sources for the database RPC.
    if (!["pending", "confirmed"].includes(appt.status)) {
      return {
        ok: false as const,
        error: "This appointment can no longer be rescheduled online. Please call the shop.",
      };
    }

    const bookingRules = await getBookingRules();
    if (
      !isSlotBookable(
        appt.appointment_date,
        String(appt.start_time).slice(0, 5),
        bookingRules.reschedulingNoticeHours,
      )
    ) {
      return {
        ok: false as const,
        error: `Rescheduling needs ${bookingRules.reschedulingNoticeHours} hours notice. Please call the shop instead.`,
      };
    }

    const serviceIds = (appt.appointment_services ?? []).flatMap((service) =>
      service.service_id ? [service.service_id] : [],
    );
    if (serviceIds.length !== (appt.appointment_services ?? []).length || serviceIds.length === 0) {
      return {
        ok: false as const,
        error:
          "The original services are no longer available for online rescheduling. Please call the shop.",
      };
    }
    const activeServices = await supabaseAdmin
      .from("services")
      .select("id")
      .in("id", serviceIds)
      .eq("is_active", true)
      .eq("is_archived", false);
    if (activeServices.error || activeServices.data.length !== serviceIds.length) {
      return {
        ok: false as const,
        error:
          "One or more original services are no longer available for online rescheduling. Please call the shop.",
      };
    }

    return {
      ok: true as const,
      appointment: {
        customerName: appt.customer_name,
        firstName: appt.first_name ?? "",
        middleName: appt.middle_name ?? "",
        lastName: appt.last_name ?? "",
        phone: appt.phone,
        motoBrand: appt.moto_brand,
        motoModel: appt.moto_model,
        motoVariant: appt.moto_variant ?? "",
        motoYear: String(appt.moto_year ?? new Date().getFullYear()),
        plateNumber: appt.plate_number,
        notes: appt.notes ?? "",
        serviceIds,
      },
    };
  });

export const lookupAppointment = createServerFn({ method: "POST" })
  .validator((input: unknown) => lookupSchema.parse(input))
  .handler(async ({ data }) => {
    const lookupRateLimit = await checkPublicRequestRateLimit("lookup", 12, 10 * 60, data.phone);
    if (lookupRateLimit !== "allowed") {
      return {
        ok: false as const,
        error:
          lookupRateLimit === "limited"
            ? "Too many lookup attempts. Please wait a few minutes before trying again."
            : "Appointment lookup is temporarily unavailable. Please try again shortly.",
      };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const appt = await findAppointment(data.reference, data.phone);
    if (!appt)
      return {
        ok: false as const,
        error: "No appointment found for that reference code and mobile number.",
      };
    const linkedIds = [
      appt.rescheduled_from_appointment_id,
      appt.rescheduled_to_appointment_id,
    ].filter((id): id is string => Boolean(id));
    const linkedReferences = new Map<string, string>();
    if (linkedIds.length > 0) {
      const linked = await supabaseAdmin
        .from("appointments")
        .select("id,reference_code")
        .in("id", linkedIds);
      if (!linked.error) {
        for (const row of linked.data ?? []) linkedReferences.set(row.id, row.reference_code);
      }
    }
    return {
      ok: true as const,
      appointment: {
        reference: appt.reference_code,
        customerName: appt.customer_name,
        firstName: appt.first_name ?? "",
        middleName: appt.middle_name ?? "",
        lastName: appt.last_name ?? "",
        phone: appt.phone,
        motorcycle: [appt.moto_brand, appt.moto_model, appt.moto_variant, appt.moto_year]
          .filter(Boolean)
          .join(" "),
        plateNumber: appt.plate_number,
        date: appt.appointment_date,
        startTime: String(appt.start_time).slice(0, 5),
        status: appt.status,
        notes: appt.notes,
        total: Number(appt.total_estimate),
        hasReplacement: Boolean(appt.rescheduled_to_appointment_id),
        rescheduleCount: appt.reschedule_count,
        rescheduleRequestPending: Boolean(appt.pending_reschedule_request_id),
        rescheduleRequestRejected: Boolean(appt.last_reschedule_rejected_at),
        rescheduleRequestRejectionMessage: appt.last_reschedule_rejection_message,
        requestedRescheduleDate: appt.pending_reschedule_date,
        requestedRescheduleStartTime: appt.pending_reschedule_start_time
          ? String(appt.pending_reschedule_start_time).slice(0, 5)
          : null,
        requestedRescheduleReference: appt.pending_reschedule_reference_code,
        requestedRescheduleReason: appt.pending_reschedule_reason,
        rescheduledFromReference: appt.rescheduled_from_appointment_id
          ? (linkedReferences.get(appt.rescheduled_from_appointment_id) ?? null)
          : null,
        rescheduledToReference: appt.rescheduled_to_appointment_id
          ? (linkedReferences.get(appt.rescheduled_to_appointment_id) ?? null)
          : null,
        services: (appt.appointment_services ?? []).map((s) => ({
          serviceId: s.service_id,
          name: s.service_name,
          price: Number(s.price),
        })),
      },
    };
  });

export const cancelAppointment = createServerFn({ method: "POST" })
  .validator((input: unknown) => lookupSchema.parse(input))
  .handler(async ({ data }) => {
    const cancellationRateLimit = await checkPublicRequestRateLimit(
      "cancellation",
      3,
      15 * 60,
      data.phone,
    );
    if (cancellationRateLimit !== "allowed") {
      return {
        ok: false as const,
        error:
          cancellationRateLimit === "limited"
            ? "Too many cancellation attempts. Please wait a few minutes before trying again."
            : "Appointment cancellation is temporarily unavailable. Please try again shortly.",
      };
    }

    const appt = await findAppointment(data.reference, data.phone);
    if (!appt)
      return {
        ok: false as const,
        error: "No appointment found for that reference code and mobile number.",
      };
    if (appt.rescheduled_to_appointment_id) {
      return {
        ok: false as const,
        error: "This appointment has already been rescheduled. Please use the new reference.",
      };
    }
    if (appt.pending_reschedule_request_id) {
      return {
        ok: false as const,
        error: "A reschedule request is already awaiting the shop's review.",
      };
    }
    if (!["pending", "confirmed", "rescheduled"].includes(appt.status)) {
      return {
        ok: false as const,
        error: "This appointment can no longer be cancelled online. Please call the shop.",
      };
    }
    const bookingRules = await getBookingRules();
    if (
      !isSlotBookable(
        appt.appointment_date,
        String(appt.start_time).slice(0, 5),
        bookingRules.cancellationNoticeHours,
      )
    ) {
      return {
        ok: false as const,
        error: `Cancellations need ${bookingRules.cancellationNoticeHours} hours notice. Please call the shop instead.`,
      };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const cancellation = await supabaseAdmin.rpc("cancel_public_appointment", {
      p_appointment_id: appt.id,
      p_cancellation_notice_hours: bookingRules.cancellationNoticeHours,
    });
    if (cancellation.error) {
      console.error("[Cancellation] atomic cancellation failed", {
        code: cancellation.error.code,
        message: cancellation.error.message,
      });
      if (
        /PGRST202|cancel_public_appointment|function .* does not exist/i.test(
          cancellation.error.message,
        )
      ) {
        return {
          ok: false as const,
          error: "Cancellation setup is incomplete. The shop needs to apply its database update.",
        };
      }
      return {
        ok: false as const,
        error:
          cancellation.error.message || "We could not cancel the appointment. Please try again.",
      };
    }
    return { ok: true as const };
  });
