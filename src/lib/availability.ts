import {
  addDays,
  intervalsOverlap,
  isBookingTimeRangeWithinHours,
  isSlotBookable,
  timeToMinutes,
  type BookingHours,
} from "./shop";

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

export type CrewSchedule = {
  crew_id: string;
  day_of_week: number;
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
  schedules: CrewSchedule[];
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

  const totalDuration = availability.totalDurationMinutes ?? 90;
  const computedSlots = availability.slots.map((slot) => {
    const slotStartMin =
      parseInt(slot.startTime.slice(0, 2)) * 60 + parseInt(slot.startTime.slice(3, 5));
    const configuredClosingMinutes = timeToMinutes(
      availability.operatingHours?.closingTime ?? "17:00",
    );
    const continuationEligible =
      availability.allowMultiDayContinuation &&
      slotStartMin + totalDuration - configuredClosingMinutes > 30;
    const slotDuration = continuationEligible
      ? Math.min(totalDuration, Math.max(0, configuredClosingMinutes - slotStartMin))
      : totalDuration;
    const slotEndMin = slotStartMin + slotDuration;

    const notBookable =
      !isSlotBookable(date, slot.startTime, availability.minimumBookingLeadHours) ||
      (!continuationEligible &&
        !isBookingTimeRangeWithinHours(slot.startTime, totalDuration, availability.operatingHours));

    const blocked = availability.blocks.some((b) => {
      if (b.date !== date) return false;
      if (!b.startTime) return true; // whole-day block
      if (b.startTime === slot.startTime) return true; // exact slot match
      if (!b.endTime) return false; // single-slot block that doesn't match
      const bsMin = parseInt(b.startTime.slice(0, 2)) * 60 + parseInt(b.startTime.slice(3, 5));
      const beMin = parseInt(b.endTime.slice(0, 2)) * 60 + parseInt(b.endTime.slice(3, 5));
      return slotStartMin < beMin && slotEndMin > bsMin;
    });

    let availableMechanics = 0;

    // Only active crew explicitly assigned to this date provide public booking
    // coverage. A date without an assigned crew has no available time slots.
    const allSchedules = availability.schedules ?? [];
    const schedulesForDate = allSchedules.filter(
      (schedule) => schedule.schedule_date === date && schedule.is_working,
    );

    // Keep this guard so a legacy duplicate cannot make a mechanic appear twice.
    const crewSchedMap = new Map<string, CrewSchedule>();
    for (const s of schedulesForDate) {
      if (!crewSchedMap.has(s.crew_id)) crewSchedMap.set(s.crew_id, s);
    }

    const dateExceptions = (availability.exceptions ?? []).filter((e) => {
      const sd = new Date(e.start_date);
      const ed = new Date(e.end_date);
      const target = new Date(date);
      return sd <= target && ed >= target;
    });

    const overlappingAppointments = (availability.assignments ?? []).filter((appointment) => {
      if (appointment.date !== date) return false;
      const appointmentStartMin = timeToMinutes(appointment.startTime);
      return intervalsOverlap(
        slotStartMin,
        slotEndMin,
        appointmentStartMin,
        appointmentStartMin + appointment.durationMinutes,
      );
    });
    const occupiedCrewIds = new Set(
      overlappingAppointments.flatMap((appointment) =>
        appointment.crewId ? [appointment.crewId] : [],
      ),
    );
    const unassignedAppointments = overlappingAppointments.filter(
      (appointment) => !appointment.crewId,
    ).length;

    for (const sched of crewSchedMap.values()) {
      const shiftStart = String(sched.start_time).slice(0, 5);
      const shiftEnd = String(sched.end_time).slice(0, 5);
      const shiftStartMin =
        parseInt(shiftStart.slice(0, 2)) * 60 + parseInt(shiftStart.slice(3, 5));
      const shiftEndMin = parseInt(shiftEnd.slice(0, 2)) * 60 + parseInt(shiftEnd.slice(3, 5));

      if (slotStartMin < shiftStartMin || slotEndMin > shiftEndMin) continue;

      const hasException = dateExceptions.some((e) => {
        if (e.crew_id !== sched.crew_id) return false;
        if (e.is_all_day) return true;
        if (e.start_time && e.end_time) {
          const excStart = String(e.start_time).slice(0, 5);
          const excEnd = String(e.end_time).slice(0, 5);
          const excStartMin = parseInt(excStart.slice(0, 2)) * 60 + parseInt(excStart.slice(3, 5));
          const excEndMin = parseInt(excEnd.slice(0, 2)) * 60 + parseInt(excEnd.slice(3, 5));
          if (slotStartMin < excEndMin && slotEndMin > excStartMin) return true;
        }
        return false;
      });

      if (hasException) continue;

      if (occupiedCrewIds.has(sched.crew_id)) continue;

      availableMechanics++;
    }

    const remaining = Math.max(
      0,
      Math.min(slot.capacity, availableMechanics) - unassignedAppointments,
    );
    const disabled = notBookable || blocked || remaining === 0;

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
