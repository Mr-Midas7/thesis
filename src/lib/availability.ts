import {
  addDays,
  intervalsOverlap,
  isBookingTimeRangeWithinHours,
  isShopOpenDate,
  isSlotBookable,
  timeToMinutes,
  type BookingHours,
} from "./shop";

export const ACTIVE_RESERVATION_STATUSES = [
  "pending",
  "confirmed",
  "in_progress",
  "rescheduled",
] as const;

const activeReservationStatusSet = new Set<string>(ACTIVE_RESERVATION_STATUSES);

export function isActiveReservationStatus(status: string | null | undefined): boolean {
  return Boolean(status && activeReservationStatusSet.has(status));
}

export type TimeSlot = {
  id: string;
  startTime: string;
  endTime: string;
  capacity: number;
};

export type DateBlock = {
  date: string;
  startTime: string | null;
  endTime: string | null;
  reason: string | null;
};

export type CrewAvailabilitySchedule = {
  crew_id: string;
  start_time: string | null;
  end_time: string | null;
  is_working: boolean;
  schedule_date: string | null;
};

export type CrewException = {
  crew_id: string;
  start_date: string;
  end_date: string;
  start_time: string | null;
  end_time: string | null;
  is_all_day: boolean;
};

export type Assignment = {
  date: string;
  startTime: string;
  durationMinutes: number;
  crewId: string | null;
};

export type CrewAvailabilityResult = {
  availableCrewIds: string[];
  unassignedReservationCount: number;
  remainingCapacity: number;
};

/**
 * Finds the crew who can perform one reservation and the capacity left after
 * existing unassigned reservations. All callers must pass only active crew
 * schedules; this keeps public availability, final booking, and continuations
 * on the same staffing rules.
 */
export function evaluateCrewAvailability({
  date,
  startTime,
  durationMinutes,
  capacity,
  schedules,
  exceptions,
  assignments,
}: {
  date: string;
  startTime: string;
  durationMinutes: number;
  capacity: number;
  schedules: CrewAvailabilitySchedule[];
  exceptions: CrewException[];
  assignments: Assignment[];
}): CrewAvailabilityResult {
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = startMinutes + durationMinutes;
  if (
    !Number.isFinite(startMinutes) ||
    !Number.isFinite(durationMinutes) ||
    durationMinutes <= 0 ||
    !Number.isFinite(endMinutes)
  ) {
    return { availableCrewIds: [], unassignedReservationCount: 0, remainingCapacity: 0 };
  }

  const schedulesByCrew = new Map<string, CrewAvailabilitySchedule[]>();
  for (const schedule of schedules) {
    if (
      schedule.schedule_date !== date ||
      !schedule.is_working ||
      !schedule.start_time ||
      !schedule.end_time
    ) {
      continue;
    }
    const crewSchedules = schedulesByCrew.get(schedule.crew_id) ?? [];
    crewSchedules.push(schedule);
    schedulesByCrew.set(schedule.crew_id, crewSchedules);
  }

  const overlappingAssignments = assignments.filter((assignment) => {
    if (assignment.date !== date) return false;
    const assignmentStart = timeToMinutes(assignment.startTime);
    return (
      Number.isFinite(assignmentStart) &&
      Number.isFinite(assignment.durationMinutes) &&
      assignment.durationMinutes > 0 &&
      intervalsOverlap(
        startMinutes,
        endMinutes,
        assignmentStart,
        assignmentStart + assignment.durationMinutes,
      )
    );
  });
  const occupiedCrewIds = new Set(
    overlappingAssignments.flatMap((assignment) => (assignment.crewId ? [assignment.crewId] : [])),
  );
  const unassignedReservationCount = overlappingAssignments.filter(
    (assignment) => !assignment.crewId,
  ).length;

  const availableCrewIds = [...schedulesByCrew.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([crewId, crewSchedules]) => {
      if (occupiedCrewIds.has(crewId)) return [];

      const shiftCoversReservation = crewSchedules.some((schedule) => {
        const shiftStart = timeToMinutes(String(schedule.start_time).slice(0, 5));
        const shiftEnd = timeToMinutes(String(schedule.end_time).slice(0, 5));
        return (
          Number.isFinite(shiftStart) &&
          Number.isFinite(shiftEnd) &&
          startMinutes >= shiftStart &&
          endMinutes <= shiftEnd
        );
      });
      if (!shiftCoversReservation) return [];

      const hasException = exceptions.some((exception) => {
        if (
          exception.crew_id !== crewId ||
          exception.start_date > date ||
          exception.end_date < date
        ) {
          return false;
        }
        if (exception.is_all_day) return true;
        if (!exception.start_time || !exception.end_time) return false;
        return intervalsOverlap(
          startMinutes,
          endMinutes,
          timeToMinutes(String(exception.start_time).slice(0, 5)),
          timeToMinutes(String(exception.end_time).slice(0, 5)),
        );
      });
      return hasException ? [] : [crewId];
    });

  const normalizedCapacity = Number.isInteger(capacity) && capacity > 0 ? capacity : 0;
  return {
    availableCrewIds,
    unassignedReservationCount,
    remainingCapacity: Math.max(
      0,
      Math.min(normalizedCapacity, availableCrewIds.length) - unassignedReservationCount,
    ),
  };
}

/** Internal scheduling data. It must stay on the server. */
export type AvailabilitySource = {
  from: string;
  to: string;
  operatingHours?: BookingHours;
  minimumBookingLeadHours?: number;
  totalDurationMinutes?: number;
  allowMultiDayContinuation?: boolean;
  slots: TimeSlot[];
  blocks: DateBlock[];
  assignments: Assignment[];
  schedules: CrewAvailabilitySchedule[];
  exceptions: CrewException[];
};

/** A slot shape that is safe to send to a public booking page. */
export type ComputedSlot = {
  id: string;
  startTime: string;
  endTime: string;
  remaining: number;
  disabled: boolean;
  notBookable: boolean;
  recommended: boolean;
};

type InternalComputedSlot = ComputedSlot & { capacity: number };

export type ContinuationSegment = {
  appointmentDate: string;
  startTime: string;
  durationMinutes: number;
  crewId: string;
};

/** The minimal availability payload exposed to public booking pages. */
export type Availability = {
  from: string;
  to: string;
  error?: string;
  totalDurationMinutes?: number;
  operatingHours?: BookingHours;
  dates: string[];
  fullyBookedDates: string[];
  slotsByDate: Record<string, ComputedSlot[]>;
  serviceEstimates?: Array<{
    id: string;
    name: string;
    price: number;
    durationMinutes: number;
    pricingSource: "default" | "model_override";
  }>;
};

function isNonSundayUnblockedDate(source: AvailabilitySource, date: string) {
  const [y, m, d] = date.split("-").map(Number);
  const dayOfWeek = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  const fullDayBlocked = source.blocks.some((block) => block.date === date && !block.startTime);
  return dayOfWeek !== 0 && !fullDayBlocked;
}

function hasOverlappingBlock(
  blocks: DateBlock[],
  date: string,
  startTime: string,
  durationMinutes: number,
) {
  const startMinutes = timeToMinutes(startTime);
  const endMinutes = startMinutes + durationMinutes;
  return blocks.some((block) => {
    if (block.date !== date) return false;
    if (!block.startTime) return true;
    if (block.startTime === startTime) return true;
    if (!block.endTime) return false;
    return intervalsOverlap(
      startMinutes,
      endMinutes,
      timeToMinutes(block.startTime),
      timeToMinutes(block.endTime),
    );
  });
}

/**
 * Reserves the remaining work on later days using the same staffing and
 * capacity calculation as the public availability grid. A null result means
 * the full multi-day reservation cannot be completed in the displayed window.
 */
export function planContinuationSegments({
  source,
  firstDate,
  remainingMinutes,
}: {
  source: AvailabilitySource;
  firstDate: string;
  remainingMinutes: number;
}): ContinuationSegment[] | null {
  if (remainingMinutes <= 0) return [];

  const closingMinutes = timeToMinutes(source.operatingHours?.closingTime ?? "17:00");
  if (!Number.isFinite(closingMinutes)) return null;

  const assignments = [...source.assignments];
  const segments: ContinuationSegment[] = [];
  let remaining = remainingMinutes;
  let cursor = addDays(firstDate, 1);

  while (remaining > 0 && cursor <= source.to) {
    if (!isShopOpenDate(cursor)) {
      cursor = addDays(cursor, 1);
      continue;
    }

    for (const slot of source.slots) {
      const slotStart = timeToMinutes(slot.startTime);
      const duration = Math.min(remaining, closingMinutes - slotStart);
      if (
        duration <= 0 ||
        slot.capacity <= 0 ||
        !isBookingTimeRangeWithinHours(slot.startTime, duration, source.operatingHours) ||
        hasOverlappingBlock(source.blocks, cursor, slot.startTime, duration)
      ) {
        continue;
      }

      const { availableCrewIds, unassignedReservationCount, remainingCapacity } =
        evaluateCrewAvailability({
          date: cursor,
          startTime: slot.startTime,
          durationMinutes: duration,
          capacity: slot.capacity,
          schedules: source.schedules,
          exceptions: source.exceptions,
          assignments,
        });
      const crewId = availableCrewIds[unassignedReservationCount];
      if (remainingCapacity <= 0 || !crewId) continue;

      const segment: ContinuationSegment = {
        appointmentDate: cursor,
        startTime: slot.startTime,
        durationMinutes: duration,
        crewId,
      };
      segments.push(segment);
      assignments.push({
        date: segment.appointmentDate,
        startTime: segment.startTime,
        durationMinutes: segment.durationMinutes,
        crewId: segment.crewId,
      });
      remaining -= duration;
      break;
    }
    cursor = addDays(cursor, 1);
  }

  return remaining === 0 ? segments : null;
}

/** Compute availability without exposing its staffing and booking inputs. */
export function buildPublicAvailability(source: AvailabilitySource): Availability {
  const out: string[] = [];
  const fullyBookedDates: string[] = [];
  const slotsByDate: Record<string, ComputedSlot[]> = {};
  let cursor = source.from;

  while (cursor <= source.to) {
    const slots = computeAvailableSlotsFromSource(source, cursor);
    slotsByDate[cursor] = slots.map(({ capacity: _capacity, ...slot }) => slot);

    if (isNonSundayUnblockedDate(source, cursor)) {
      const hasOpenSlot = slots.some((slot) => !slot.disabled);
      if (hasOpenSlot) out.push(cursor);

      const hasCapacityFreeFromBlocks = slots.some(
        (slot) => !slot.notBookable && slot.remaining > 0,
      );
      if (!hasOpenSlot && !hasCapacityFreeFromBlocks && slots.length > 0) {
        fullyBookedDates.push(cursor);
      }
    }
    cursor = addDays(cursor, 1);
  }

  return {
    from: source.from,
    to: source.to,
    ...(source.totalDurationMinutes === undefined
      ? {}
      : { totalDurationMinutes: source.totalDurationMinutes }),
    ...(source.operatingHours === undefined ? {} : { operatingHours: source.operatingHours }),
    dates: out,
    fullyBookedDates,
    slotsByDate,
  };
}

/** Compute the per-slot availability for one date from private scheduling data. */
function computeAvailableSlotsFromSource(
  availability: AvailabilitySource,
  date: string,
): InternalComputedSlot[] {
  if (!date || !availability.slots?.length) return [];

  const totalDuration = availability.totalDurationMinutes ?? 60;
  const computedSlots = availability.slots.map((slot) => {
    const slotStartMin =
      parseInt(slot.startTime.slice(0, 2)) * 60 + parseInt(slot.startTime.slice(3, 5));
    const configuredClosingMinutes = timeToMinutes(
      availability.operatingHours?.closingTime ?? "17:00",
    );
    const continuationEligible =
      availability.allowMultiDayContinuation &&
      slotStartMin + totalDuration > configuredClosingMinutes;
    const slotDuration = continuationEligible
      ? Math.min(totalDuration, Math.max(0, configuredClosingMinutes - slotStartMin))
      : totalDuration;

    const notBookable =
      !isSlotBookable(date, slot.startTime, availability.minimumBookingLeadHours) ||
      (!continuationEligible &&
        !isBookingTimeRangeWithinHours(slot.startTime, totalDuration, availability.operatingHours));

    const blocked = hasOverlappingBlock(availability.blocks, date, slot.startTime, slotDuration);

    const { remainingCapacity: remaining } = evaluateCrewAvailability({
      date,
      startTime: slot.startTime,
      durationMinutes: slotDuration,
      capacity: slot.capacity,
      schedules: availability.schedules,
      exceptions: availability.exceptions,
      assignments: availability.assignments,
    });
    const continuationPlan = continuationEligible
      ? planContinuationSegments({
          source: availability,
          firstDate: date,
          remainingMinutes: totalDuration - slotDuration,
        })
      : [];
    const disabled = notBookable || blocked || remaining === 0 || continuationPlan === null;

    return {
      ...slot,
      remaining,
      disabled,
      notBookable,
      recommended: false,
    };
  });

  const bestRemaining = Math.max(
    0,
    ...computedSlots.filter((slot) => !slot.disabled).map((slot) => slot.remaining),
  );
  let recommendedAssigned = false;
  return computedSlots.map((slot) => {
    const recommended =
      !recommendedAssigned &&
      !slot.disabled &&
      slot.remaining === bestRemaining &&
      bestRemaining > 0;
    if (recommended) recommendedAssigned = true;
    return { ...slot, recommended };
  });
}

export function computeAvailableDates(availability: Availability): string[] {
  return availability.dates;
}

export function computeAvailableSlots(availability: Availability, date: string): ComputedSlot[] {
  return availability.slotsByDate[date] ?? [];
}

export function computeFullyBookedDates(availability: Availability): string[] {
  return availability.fullyBookedDates;
}
