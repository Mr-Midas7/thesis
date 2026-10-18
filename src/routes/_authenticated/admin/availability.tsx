import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { format } from "date-fns";
import {
  CalendarRange,
  CalendarSearch,
  Check,
  ChevronDown,
  Filter,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";

import {
  AdminPage,
  DataList,
  InlineAlert,
  ListCard,
  ListCardTitle,
  ListEmpty,
  ListToolbar,
  ToolbarFilters,
} from "@/components/admin/data-list";
import { PageHeader } from "@/components/admin/page-header";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { FieldError } from "@/components/ui/field-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  calendarDateToIso,
  calendarRangeToIso,
  isoDateToCalendarDate,
  manilaMonthDateRange,
  manilaWeekDateRange,
  normalizeIsoDateRange,
} from "@/lib/admin-date-range";
import { formatDateLong, formatTime, manilaNow, shopTimeOptions } from "@/lib/shop";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/availability")({
  component: AvailabilityPage,
});

const SHIFT_PRESETS = {
  "whole-day": { start: "08:00", end: "17:00", label: "Whole Day (8:00 AM – 5:00 PM)" },
  morning: { start: "08:00", end: "12:00", label: "Morning (8:00 AM – 12:00 PM)" },
  afternoon: { start: "13:00", end: "17:00", label: "Afternoon (1:00 PM – 5:00 PM)" },
} as const;

const PRESET_LABELS: Record<string, string> = {};
for (const preset of Object.values(SHIFT_PRESETS)) {
  PRESET_LABELS[`${preset.start}|${preset.end}`] = preset.label;
}

type ScheduleWithCrew = {
  id: string;
  crew_id: string;
  day_of_week: number;
  start_time: string | null;
  end_time: string | null;
  is_working: boolean;
  schedule_date: string | null;
  note: string | null;
  crew_members?: { name: string; role: string } | null;
};

type WorkingMechanic = {
  id: string;
  crew_id: string;
  schedule_date: string;
  name: string;
  role: string;
  start_time: string | null;
  end_time: string | null;
  is_date_assignment: boolean;
};

type AssignmentFilter = {
  crewId: string;
  role: string;
  period: "weekly" | "monthly" | "custom";
  customStart: string;
  customEnd: string;
};

type CrewMember = {
  id: string;
  name: string;
  role: string;
};

/** A booking, or a later day of a multi-day booking, assigned to a mechanic. */
type ShiftWork = {
  key: string;
  referenceCode: string;
  customerName: string;
  startTime: string;
  durationMinutes: number;
};

/** What change_crew_schedule returns: the bookings it gave to other mechanics. */
type ShiftChangeResult = {
  moved: { reference_code: string; start_time: string; mechanic: string }[];
};

const ACTIVE_WORK_STATUSES = ["pending", "confirmed", "in_progress", "rescheduled"] as const;

async function fetchShiftWork(crewId: string, date: string): Promise<ShiftWork[]> {
  const [appointments, continuations] = await Promise.all([
    supabase
      .from("appointments")
      .select("id,reference_code,customer_name,start_time,booking_duration_minutes")
      .eq("assigned_crew_id", crewId)
      .eq("appointment_date", date)
      .eq("is_archived", false)
      .is("rescheduled_to_appointment_id", null)
      .in("status", [...ACTIVE_WORK_STATUSES]),
    supabase
      .from("appointment_continuations")
      .select(
        "id,start_time,booking_duration_minutes,appointments!inner(reference_code,customer_name)",
      )
      .eq("assigned_crew_id", crewId)
      .eq("appointment_date", date)
      .eq("appointments.is_archived", false)
      .is("appointments.rescheduled_to_appointment_id", null)
      .in("appointments.status", [...ACTIVE_WORK_STATUSES]),
  ]);
  if (appointments.error) throw appointments.error;
  if (continuations.error) throw continuations.error;
  return [
    ...(appointments.data ?? []).map((appointment) => ({
      key: appointment.id,
      referenceCode: appointment.reference_code,
      customerName: appointment.customer_name,
      startTime: String(appointment.start_time).slice(0, 5),
      durationMinutes: appointment.booking_duration_minutes ?? 0,
    })),
    ...(continuations.data ?? []).map((continuation) => ({
      key: continuation.id,
      referenceCode: continuation.appointments.reference_code,
      customerName: continuation.appointments.customer_name,
      startTime: String(continuation.start_time).slice(0, 5),
      durationMinutes: continuation.booking_duration_minutes,
    })),
  ].sort((first, second) => first.startTime.localeCompare(second.startTime));
}

function minutesOf(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

/** Work that no longer fits between the new start and end. */
function workOutsideHours(work: ShiftWork[], start: string, end: string) {
  return work.filter(
    (item) =>
      minutesOf(item.startTime) < minutesOf(start) ||
      minutesOf(item.startTime) + item.durationMinutes > minutesOf(end),
  );
}

function shiftLabel(start: string | null, end: string | null) {
  if (!start || !end) return "Not set";
  return PRESET_LABELS[`${start}|${end}`] ?? `${formatTime(start)} – ${formatTime(end)}`;
}

function movedSummary(result: ShiftChangeResult) {
  return result.moved
    .map(
      (booking) =>
        ` ${booking.reference_code} (${formatTime(booking.start_time.slice(0, 5))}) now goes to ${booking.mechanic}.`,
    )
    .join("");
}

function shiftChangeError(error: { message?: string; hint?: string }, action: "remove" | "edit") {
  if (error.hint === "crew_shift_conflict") {
    return `${error.message} Reschedule or cancel that booking first, or ${
      action === "remove" ? "keep this shift" : "choose hours that still cover it"
    }.`;
  }
  if (/no longer exists|must end after it starts/i.test(error.message ?? "")) {
    return error.message ?? "";
  }
  console.error("Shift change failed:", error);
  return "Could not change this shift. Please try again.";
}

function listDays(dates: string[]) {
  const labels = dates.map((date) => format(dateFromKey(date), "MMM d"));
  return labels.length > 1
    ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`
    : (labels[0] ?? "");
}

function dateToKey(date: Date) {
  return calendarDateToIso(date);
}

function dateFromKey(value: string) {
  return isoDateToCalendarDate(value);
}

function assignmentPeriodBounds(filter: AssignmentFilter) {
  if (filter.period === "custom") {
    return normalizeIsoDateRange(filter.customStart, filter.customEnd);
  }

  const today = manilaNow().date;
  return filter.period === "monthly" ? manilaMonthDateRange(today) : manilaWeekDateRange(today);
}

function AvailabilityDateRangeFilter({
  period,
  dateFrom,
  dateTo,
  onPeriodChange,
  onCustomDateRangeChange,
}: {
  period: AssignmentFilter["period"];
  dateFrom: string;
  dateTo: string;
  onPeriodChange: (period: AssignmentFilter["period"]) => void;
  onCustomDateRangeChange: (dateFrom: string, dateTo: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [isPickingCustomRange, setIsPickingCustomRange] = useState(false);
  const [draftRange, setDraftRange] = useState<DateRange>();
  const selectedRange = dateFrom
    ? { from: dateFromKey(dateFrom), to: dateTo ? dateFromKey(dateTo) : undefined }
    : undefined;

  const selectPeriod = (nextPeriod: Exclude<AssignmentFilter["period"], "custom">) => {
    onPeriodChange(nextPeriod);
    setIsPickingCustomRange(false);
    setOpen(false);
  };

  const cancelCustomRange = () => {
    setDraftRange(selectedRange);
    setIsPickingCustomRange(false);
    setOpen(false);
  };

  const applyCustomRange = () => {
    if (!draftRange?.from || !draftRange.to) return;
    const range = calendarRangeToIso(draftRange);
    if (!range) return;
    onCustomDateRangeChange(range.from, range.to);
    onPeriodChange("custom");
    setIsPickingCustomRange(false);
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setIsPickingCustomRange(false);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label="Select availability date range"
          title={availabilityDatePeriodLabel(period, dateFrom, dateTo)}
          className="w-full justify-between gap-2 px-3 text-left font-normal"
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            <CalendarRange className="size-4 shrink-0" aria-hidden="true" />
            {availabilityDatePeriodLabel(period, dateFrom, dateTo)}
          </span>
          <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        {isPickingCustomRange ? (
          <div>
            <div className="px-2 pb-2">
              <p className="text-sm font-medium">Custom date range</p>
              <p className="text-xs text-muted-foreground">Select a start date and an end date.</p>
            </div>
            <Calendar
              mode="range"
              selected={draftRange}
              onSelect={setDraftRange}
              className="mx-auto p-0"
              classNames={{
                nav: "inset-x-auto left-1/2 w-48 -translate-x-1/2 justify-between",
              }}
            />
            <div className="mt-2 grid grid-cols-2 gap-2 px-2 text-xs">
              <AvailabilityDateRangeValue label="Start date" value={draftRange?.from} />
              <AvailabilityDateRangeValue label="End date" value={draftRange?.to} />
            </div>
            <div className="mt-3 flex justify-end gap-2 border-t border-border pt-3">
              <Button type="button" variant="outline" size="sm" onClick={cancelCustomRange}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={applyCustomRange}
                disabled={!draftRange?.from || !draftRange.to}
              >
                Apply
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="px-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Date range
            </p>
            <AvailabilityDateOption
              active={period === "weekly"}
              label="This Week"
              onClick={() => selectPeriod("weekly")}
            />
            <AvailabilityDateOption
              active={period === "monthly"}
              label="This Month"
              onClick={() => selectPeriod("monthly")}
            />
            <AvailabilityDateOption
              active={period === "custom"}
              label="Custom Date Range"
              onClick={() => {
                setDraftRange(selectedRange);
                setIsPickingCustomRange(true);
              }}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function AvailabilityDateOption({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className={cn("h-9 w-full justify-start text-sm", active && "bg-muted")}
      onClick={onClick}
    >
      {label}
    </Button>
  );
}

function AvailabilityDateRangeValue({ label, value }: { label: string; value: Date | undefined }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-2 py-1.5">
      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-0.5 truncate font-medium text-foreground">
        {value ? format(value, "MMM d, yyyy") : "Not selected"}
      </p>
    </div>
  );
}

/** "This week · All crew members · All roles", for the results header. */
function assignmentFilterSummary(filter: AssignmentFilter, crew: CrewMember[]) {
  const period =
    filter.period === "custom"
      ? availabilityDatePeriodLabel(filter.period, filter.customStart, filter.customEnd)
      : filter.period === "monthly"
        ? "This month"
        : "This week";
  const member =
    filter.crewId === "all"
      ? "All crew members"
      : (crew.find((item) => item.id === filter.crewId)?.name ?? "Selected crew member");
  const role = filter.role === "all" ? "All roles" : filter.role;
  return [period, member, role].join(" · ");
}

function availabilityDatePeriodLabel(
  period: AssignmentFilter["period"],
  dateFrom: string,
  dateTo: string,
) {
  if (period === "weekly") return "This Week";
  if (period === "monthly") return "This Month";
  if (!dateFrom) return "Custom Date Range";

  const fromDate = dateFromKey(dateFrom);
  const fromLabel = format(fromDate, "MMM d, yyyy");
  if (!dateTo) return `${fromLabel} – Select end date`;

  const toDate = dateFromKey(dateTo);
  return fromDate.getFullYear() === toDate.getFullYear()
    ? `${format(fromDate, "MMM d")} – ${format(toDate, "MMM d, yyyy")}`
    : `${fromLabel} – ${format(toDate, "MMM d, yyyy")}`;
}

function AvailabilityPage() {
  const qc = useQueryClient();
  const [filterCrewId, setFilterCrewId] = useState("all");
  const [filterRole, setFilterRole] = useState("all");
  const [filterPeriod, setFilterPeriod] = useState<AssignmentFilter["period"]>("weekly");
  const [customPeriodStart, setCustomPeriodStart] = useState("");
  const [customPeriodEnd, setCustomPeriodEnd] = useState("");
  const [appliedFilter, setAppliedFilter] = useState<AssignmentFilter | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [assignDates, setAssignDates] = useState<Date[]>([]);
  const [assignMechanic, setAssignMechanic] = useState<string>("");
  const [assignShift, setAssignShift] = useState("whole-day");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [filterErrors, setFilterErrors] = useState<
    Partial<Record<"customStart" | "customEnd", string | undefined>>
  >({});
  const [assignmentErrors, setAssignmentErrors] = useState<
    Partial<Record<"dates" | "mechanic" | "customStart" | "customEnd", string | undefined>>
  >({});
  const [removeTarget, setRemoveTarget] = useState<WorkingMechanic | null>(null);
  const [editTarget, setEditTarget] = useState<WorkingMechanic | null>(null);
  const [editShift, setEditShift] = useState("whole-day");
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [shiftError, setShiftError] = useState<string | null>(null);
  const [shiftNotice, setShiftNotice] = useState<string | null>(null);

  const crew = useQuery({
    queryKey: ["crew-active"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("crew_members")
        .select("*")
        .eq("is_active", true)
        .eq("is_archived", false)
        .order("name");
      if (error) throw error;
      return Array.from(
        new Map((data ?? []).map((c) => [c.name.trim(), c])).values(),
      ) as CrewMember[];
    },
  });

  const schedules = useQuery({
    queryKey: ["crew-schedules-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("crew_schedules")
        .select("*,crew_members!inner(name,role)")
        .order("crew_id")
        .order("schedule_date", { ascending: true, nullsFirst: false })
        .order("day_of_week");
      if (error) throw error;
      return (data ?? []) as ScheduleWithCrew[];
    },
  });

  const saveSchedule = useMutation({
    mutationFn: async (payload: {
      crew_id: string;
      schedule_dates: string[];
      start_time: string;
      end_time: string;
      is_working: boolean;
      note?: string;
    }) => {
      const { error } = await supabase.from("crew_schedules").upsert(
        payload.schedule_dates.map((scheduleDate) => {
          const [y, m, d] = scheduleDate.split("-").map(Number);
          return {
            crew_id: payload.crew_id,
            schedule_date: scheduleDate,
            day_of_week: new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay(),
            start_time: payload.is_working ? `${payload.start_time}:00` : null,
            end_time: payload.is_working ? `${payload.end_time}:00` : null,
            is_working: payload.is_working,
            note: payload.note || null,
          };
        }),
        // A day marked as not working is replaced by the new shift.
        { onConflict: "crew_id,schedule_date" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crew-schedules-all"] });
    },
    onError: (err: Error) => {
      const msg = err.message.toLowerCase();
      if (msg.includes("unique") || msg.includes("duplicate")) {
        setAssignmentErrors({
          dates: "A schedule for this crew on this date already exists. Remove or edit it first.",
        });
      } else if (msg.includes("foreign")) {
        setAssignmentErrors({
          mechanic: "Referenced crew member no longer exists. Refresh the page and try again.",
        });
      } else {
        console.error("Schedule save failed:", err);
        setAssignmentErrors({
          dates: "Could not save the schedule. Please try again.",
        });
      }
    },
  });

  const shiftTarget = removeTarget ?? editTarget;
  const shiftWork = useQuery({
    queryKey: ["crew-shift-work", shiftTarget?.crew_id, shiftTarget?.schedule_date],
    enabled: Boolean(shiftTarget),
    queryFn: () => fetchShiftWork(shiftTarget!.crew_id, shiftTarget!.schedule_date),
  });

  const changeShift = useMutation({
    mutationFn: async (input: {
      scheduleId: string;
      remove: boolean;
      start?: string;
      end?: string;
    }) => {
      const { data, error } = await supabase.rpc("change_crew_schedule", {
        p_schedule_id: input.scheduleId,
        p_remove: input.remove,
        p_start_time: input.start ? `${input.start}:00` : null,
        p_end_time: input.end ? `${input.end}:00` : null,
      });
      if (error) throw error;
      return data as unknown as ShiftChangeResult;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["crew-schedules-all"] });
      qc.invalidateQueries({ queryKey: ["crew-shift-work"] });
      qc.invalidateQueries({ queryKey: ["admin-appointments"] });
      qc.invalidateQueries({ queryKey: ["admin-dashboard"], exact: false });
    },
  });

  function openRemove(row: WorkingMechanic) {
    setShiftError(null);
    setShiftNotice(null);
    setRemoveTarget(row);
  }

  function openEdit(row: WorkingMechanic) {
    const preset = Object.entries(SHIFT_PRESETS).find(
      ([, hours]) => hours.start === row.start_time && hours.end === row.end_time,
    )?.[0];
    setEditShift(preset ?? "custom");
    setEditStart(preset ? "" : (row.start_time ?? ""));
    setEditEnd(preset ? "" : (row.end_time ?? ""));
    setShiftError(null);
    setShiftNotice(null);
    setEditTarget(row);
  }

  /** The hours chosen in the edit dialog, or null if they are incomplete. */
  function chosenEditHours() {
    if (editShift !== "custom") {
      const preset = SHIFT_PRESETS[editShift as keyof typeof SHIFT_PRESETS];
      return { start: preset.start, end: preset.end };
    }
    return editStart && editEnd && editStart < editEnd ? { start: editStart, end: editEnd } : null;
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setShiftError(null);
    try {
      const result = await changeShift.mutateAsync({ scheduleId: removeTarget.id, remove: true });
      setShiftNotice(
        `Removed ${removeTarget.name}'s shift on ${formatDateLong(removeTarget.schedule_date)}.${movedSummary(result)}`,
      );
      setRemoveTarget(null);
    } catch (error) {
      setShiftError(shiftChangeError(error as { message?: string; hint?: string }, "remove"));
    }
  }

  async function saveEdit() {
    if (!editTarget) return;
    const hours = chosenEditHours();
    if (!hours) {
      setShiftError(
        !editStart || !editEnd
          ? "Select a start and an end time."
          : "End time must be after start time.",
      );
      return;
    }
    if (hours.start === editTarget.start_time && hours.end === editTarget.end_time) {
      setEditTarget(null);
      return;
    }
    setShiftError(null);
    try {
      const result = await changeShift.mutateAsync({
        scheduleId: editTarget.id,
        remove: false,
        ...hours,
      });
      setShiftNotice(
        `Changed ${editTarget.name}'s shift on ${formatDateLong(editTarget.schedule_date)} to ${shiftLabel(hours.start, hours.end)}.${movedSummary(result)}`,
      );
      setEditTarget(null);
    } catch (error) {
      setShiftError(shiftChangeError(error as { message?: string; hint?: string }, "edit"));
    }
  }

  const editHours = chosenEditHours();
  const editAffected = editHours
    ? workOutsideHours(shiftWork.data ?? [], editHours.start, editHours.end)
    : [];

  const assignDateStrs = useMemo(() => assignDates.map(dateToKey), [assignDates]);
  const roleOptions = useMemo(
    () =>
      Array.from(
        new Set(
          (schedules.data ?? [])
            .map((schedule) => schedule.crew_members?.role)
            .filter((role): role is string => Boolean(role)),
        ),
      ).sort(),
    [schedules.data],
  );

  const filteredAssignments = useMemo(() => {
    if (!appliedFilter) return null;
    const { from, to } = assignmentPeriodBounds(appliedFilter);
    const crewMap = new Map((crew.data ?? []).map((member) => [member.id, member]));

    return (schedules.data ?? [])
      .filter(
        (schedule) =>
          schedule.is_working &&
          schedule.schedule_date &&
          schedule.schedule_date >= from &&
          schedule.schedule_date <= to &&
          (appliedFilter.crewId === "all" || schedule.crew_id === appliedFilter.crewId) &&
          (appliedFilter.role === "all" || schedule.crew_members?.role === appliedFilter.role),
      )
      .map((schedule) => ({
        id: schedule.id,
        crew_id: schedule.crew_id,
        schedule_date: schedule.schedule_date as string,
        name: schedule.crew_members?.name ?? crewMap.get(schedule.crew_id)?.name ?? "Unknown",
        role: schedule.crew_members?.role ?? "Mechanic",
        start_time: schedule.start_time ? String(schedule.start_time).slice(0, 5) : null,
        end_time: schedule.end_time ? String(schedule.end_time).slice(0, 5) : null,
        is_date_assignment: true,
      }))
      .sort(
        (first, second) =>
          first.schedule_date.localeCompare(second.schedule_date) ||
          first.name.localeCompare(second.name),
      ) as WorkingMechanic[];
  }, [appliedFilter, crew.data, schedules.data]);

  function applyAssignmentFilter() {
    if (filterPeriod === "custom") {
      const nextErrors: Partial<Record<"customStart" | "customEnd", string>> = {};
      if (!customPeriodStart || !customPeriodEnd) {
        if (!customPeriodStart) nextErrors.customStart = "Choose a custom period start date.";
        if (!customPeriodEnd) nextErrors.customEnd = "Choose a custom period end date.";
      }
      if (customPeriodStart && customPeriodEnd && customPeriodStart > customPeriodEnd) {
        nextErrors.customEnd = "The custom period end must be after the start date.";
      }
      setFilterErrors(nextErrors);
      if (Object.keys(nextErrors).length) {
        return;
      }
    }
    setAppliedFilter({
      crewId: filterCrewId,
      role: filterRole,
      period: filterPeriod,
      customStart: customPeriodStart,
      customEnd: customPeriodEnd,
    });
  }

  function clearAssignmentFilter() {
    setFilterCrewId("all");
    setFilterRole("all");
    setFilterPeriod("weekly");
    setCustomPeriodStart("");
    setCustomPeriodEnd("");
    setAppliedFilter(null);
  }

  const handleSave = async () => {
    const nextErrors: Partial<Record<"dates" | "mechanic" | "customStart" | "customEnd", string>> =
      {};
    if (assignDateStrs.length === 0) nextErrors.dates = "Select at least one working day.";
    if (!assignMechanic) nextErrors.mechanic = "Select a mechanic.";
    if (Object.keys(nextErrors).length) {
      setAssignmentErrors(nextErrors);
      return;
    }

    const workingDates = new Set(
      (schedules.data ?? [])
        .filter(
          (schedule) =>
            schedule.crew_id === assignMechanic && schedule.is_working && schedule.schedule_date,
        )
        .map((schedule) => schedule.schedule_date as string),
    );
    const alreadyWorking = assignDateStrs.filter((date) => workingDates.has(date)).sort();
    if (alreadyWorking.length > 0) {
      const mechanicName =
        (crew.data ?? []).find((member) => member.id === assignMechanic)?.name ?? "This mechanic";
      setAssignmentErrors({
        dates: `${mechanicName} already has a shift on ${listDays(alreadyWorking)}. Unselect ${
          alreadyWorking.length === 1 ? "that day" : "those days"
        }, or use Edit on the existing shift.`,
      });
      return;
    }

    let startTime: string;
    let endTime: string;

    if (assignShift === "custom") {
      if (!customStart || !customEnd) {
        setAssignmentErrors({
          ...(customStart ? {} : { customStart: "Select a start time." }),
          ...(customEnd ? {} : { customEnd: "Select an end time." }),
        });
        return;
      }
      if (customStart >= customEnd) {
        setAssignmentErrors({ customEnd: "End time must be after start time." });
        return;
      }
      startTime = customStart;
      endTime = customEnd;
    } else {
      const preset = SHIFT_PRESETS[assignShift as keyof typeof SHIFT_PRESETS];
      startTime = preset.start;
      endTime = preset.end;
    }

    try {
      setAssignmentErrors({});
      await saveSchedule.mutateAsync({
        crew_id: assignMechanic,
        schedule_dates: assignDateStrs,
        start_time: startTime,
        end_time: endTime,
        is_working: true,
      });
      setAssignMechanic("");
      setAssignDates([]);
      setAssignShift("whole-day");
      setCustomStart("");
      setCustomEnd("");
      setDialogOpen(false);
    } catch {
      // Error is shown inline by the mutation callback.
    }
  };

  const openAssignDialog = () => {
    setAssignMechanic("");
    setAssignShift("whole-day");
    setCustomStart("");
    setCustomEnd("");
    setAssignDates([]);
    setDialogOpen(true);
  };

  return (
    <AdminPage>
      <PageHeader
        title="Crew Scheduling"
        description="Find and manage crew assignments by crew member, role, and period."
        action={
          <Button className="font-display uppercase" onClick={openAssignDialog}>
            <Plus /> Assign crew
          </Button>
        }
      />
      {shiftNotice && (
        <p
          role="status"
          className="mb-4 flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-400"
        >
          <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{shiftNotice}</span>
        </p>
      )}

      <ListToolbar
        summary={
          filteredAssignments &&
          `${filteredAssignments.length} ${filteredAssignments.length === 1 ? "assignment" : "assignments"}`
        }
      >
        <ToolbarFilters>
          <Select value={filterCrewId} onValueChange={setFilterCrewId}>
            <SelectTrigger aria-label="Filter by crew member" className="w-full sm:w-48">
              <SelectValue placeholder="All crew members" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All crew members</SelectItem>
              {(crew.data ?? []).map((member) => (
                <SelectItem key={member.id} value={member.id}>
                  {member.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterRole} onValueChange={setFilterRole}>
            <SelectTrigger aria-label="Filter by role" className="w-full sm:w-40">
              <SelectValue placeholder="All roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              {roleOptions.map((role) => (
                <SelectItem key={role} value={role}>
                  {role}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="col-span-2 sm:w-56">
            <AvailabilityDateRangeFilter
              period={filterPeriod}
              dateFrom={customPeriodStart}
              dateTo={customPeriodEnd}
              onPeriodChange={setFilterPeriod}
              onCustomDateRangeChange={(dateFrom, dateTo) => {
                setCustomPeriodStart(dateFrom);
                setCustomPeriodEnd(dateTo);
                setFilterErrors({});
              }}
            />
          </div>
          <Button type="button" onClick={applyAssignmentFilter}>
            <Filter /> Apply filters
          </Button>
          <Button type="button" variant="outline" onClick={clearAssignmentFilter}>
            <RotateCcw /> Reset
          </Button>
        </ToolbarFilters>
      </ListToolbar>
      {filterPeriod === "custom" && (
        <FieldError
          message={filterErrors.customStart ?? filterErrors.customEnd}
          className="-mt-2 mb-4"
        />
      )}

      <ListCard
        header={
          <ListCardTitle
            title="Crew assignments"
            description={
              appliedFilter
                ? assignmentFilterSummary(appliedFilter, crew.data ?? [])
                : "Choose your crew, role, and period, then apply the filters."
            }
          />
        }
      >
        {filteredAssignments === null ? (
          <ListEmpty
            icon={CalendarSearch}
            title="No search yet"
            description="Choose your crew, role, and period, then apply the filters to see assignments."
          />
        ) : (
          <DataList
            label="Crew assignments"
            rows={filteredAssignments}
            rowKey={(w) => w.id}
            loading={schedules.isLoading}
            error={
              schedules.isError
                ? {
                    message: "Could not load crew schedules.",
                    onRetry: () => void schedules.refetch(),
                  }
                : null
            }
            empty={
              <ListEmpty
                icon={CalendarSearch}
                title="No crew assignments match these filters."
                description="Try another crew member, role, or period, or assign crew to these days."
                action={
                  <Button size="sm" onClick={openAssignDialog}>
                    <Plus /> Assign crew
                  </Button>
                }
              />
            }
            columns={[
              {
                key: "date",
                header: "Date",
                card: "title",
                className: "w-52",
                cell: (w) => <span className="font-medium">{formatDateLong(w.schedule_date)}</span>,
              },
              {
                key: "name",
                header: "Mechanic",
                cell: (w) => (
                  <span className="text-sm">
                    {w.name}
                    <span className="block text-xs text-muted-foreground">{w.role}</span>
                  </span>
                ),
              },
              {
                key: "shift",
                header: "Shift",
                card: "wide",
                className: "w-56",
                cell: (w) => (
                  <span className="text-sm">{shiftLabel(w.start_time, w.end_time)}</span>
                ),
              },
            ]}
            // Icons only on small laptops, where the labels would squeeze the table.
            actionsClassName="w-32 xl:w-52"
            actions={(w) =>
              w.is_date_assignment ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openEdit(w)}
                    aria-label={`Edit ${w.name}'s shift on ${formatDateLong(w.schedule_date)}`}
                  >
                    <Pencil /> <span className="lg:max-xl:sr-only">Edit</span>
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => openRemove(w)}
                    aria-label={`Remove ${w.name}'s shift on ${formatDateLong(w.schedule_date)}`}
                  >
                    <Trash2 /> <span className="lg:max-xl:sr-only">Remove</span>
                  </Button>
                </>
              ) : null
            }
          />
        )}
      </ListCard>

      <AlertDialog
        open={Boolean(removeTarget)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !changeShift.isPending) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this shift?</AlertDialogTitle>
            <AlertDialogDescription>
              {removeTarget &&
                `${removeTarget.name} · ${formatDateLong(removeTarget.schedule_date)} · ${shiftLabel(removeTarget.start_time, removeTarget.end_time)}`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ShiftWorkNotice
            loading={shiftWork.isLoading}
            failed={shiftWork.isError}
            affected={shiftWork.data ?? []}
            emptyMessage={`No bookings are assigned to ${removeTarget?.name ?? "this mechanic"} on this day.`}
          />
          {shiftError && <InlineAlert className="mb-0">{shiftError}</InlineAlert>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={changeShift.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => void confirmRemove()}
              disabled={changeShift.isPending || shiftWork.isLoading || shiftWork.isError}
            >
              {changeShift.isPending && <Loader2 className="animate-spin" />}
              {(shiftWork.data?.length ?? 0) > 0 ? "Remove and move bookings" : "Remove shift"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={Boolean(editTarget)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !changeShift.isPending) setEditTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display uppercase">Edit shift</DialogTitle>
            <DialogDescription>
              {editTarget && `${editTarget.name} · ${formatDateLong(editTarget.schedule_date)}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <ShiftHoursFields
              shift={editShift}
              start={editStart}
              end={editEnd}
              onShiftChange={(value) => {
                setEditShift(value);
                setEditStart(value === "custom" ? (editTarget?.start_time ?? "") : "");
                setEditEnd(value === "custom" ? (editTarget?.end_time ?? "") : "");
                setShiftError(null);
              }}
              onStartChange={(value) => {
                setEditStart(value);
                setShiftError(null);
              }}
              onEndChange={(value) => {
                setEditEnd(value);
                setShiftError(null);
              }}
            />
            <ShiftWorkNotice
              loading={shiftWork.isLoading}
              failed={shiftWork.isError}
              affected={editAffected}
              emptyMessage={`Every booking assigned to ${editTarget?.name ?? "this mechanic"} on this day fits these hours.`}
            />
            {shiftError && <InlineAlert className="mb-0">{shiftError}</InlineAlert>}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setEditTarget(null)}
              disabled={changeShift.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void saveEdit()}
              disabled={changeShift.isPending || shiftWork.isLoading || shiftWork.isError}
            >
              {changeShift.isPending && <Loader2 className="animate-spin" />}
              Save shift
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assign crew dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display uppercase">Assign crew</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Working days</Label>
              <Calendar
                mode="multiple"
                selected={assignDates}
                onSelect={(dates) => {
                  setAssignDates(dates ?? []);
                  setAssignmentErrors((current) => ({ ...current, dates: undefined }));
                }}
                className={cn("border-border/70", assignmentErrors.dates && "border-destructive")}
                classNames={{
                  months: "w-full",
                  month: "w-full",
                  table: "w-full",
                  nav: "justify-between gap-1",
                  month_caption:
                    "flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
                }}
              />
              <p className="text-xs text-muted-foreground">
                {assignDateStrs.length === 0
                  ? "Choose one or more days for this crew member."
                  : `${assignDateStrs.length} ${assignDateStrs.length === 1 ? "day" : "days"} selected.`}
              </p>
              <FieldError message={assignmentErrors.dates} />
            </div>

            <div className="space-y-1.5">
              <Label>Mechanic</Label>
              <Select
                value={assignMechanic}
                onValueChange={(value) => {
                  setAssignMechanic(value);
                  setAssignmentErrors((current) => ({ ...current, mechanic: undefined }));
                }}
                disabled={crew.isLoading}
              >
                <SelectTrigger className="w-full" aria-invalid={!!assignmentErrors.mechanic}>
                  <SelectValue placeholder="Select a mechanic" />
                </SelectTrigger>
                <SelectContent>
                  {(crew.data ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} ({c.role})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldError message={assignmentErrors.mechanic} />
            </div>

            <ShiftHoursFields
              shift={assignShift}
              start={customStart}
              end={customEnd}
              errors={assignmentErrors}
              onShiftChange={(value) => {
                setAssignShift(value);
                setCustomStart("");
                setCustomEnd("");
              }}
              onStartChange={(value) => {
                setCustomStart(value);
                setAssignmentErrors((current) => ({ ...current, customStart: undefined }));
              }}
              onEndChange={(value) => {
                setCustomEnd(value);
                setAssignmentErrors((current) => ({ ...current, customEnd: undefined }));
              }}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
              Close
            </Button>
            <Button onClick={handleSave} disabled={saveSchedule.isPending}>
              {saveSchedule.isPending && <Loader2 className="animate-spin" />}
              Save working days
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AdminPage>
  );
}

/** The shift preset picker, with start and end times for a custom shift. */
function ShiftHoursFields({
  shift,
  start,
  end,
  errors = {},
  onShiftChange,
  onStartChange,
  onEndChange,
}: {
  shift: string;
  start: string;
  end: string;
  errors?: { customStart?: string | undefined; customEnd?: string | undefined };
  onShiftChange: (value: string) => void;
  onStartChange: (value: string) => void;
  onEndChange: (value: string) => void;
}) {
  return (
    <>
      <div className="space-y-1.5">
        <Label>Shift</Label>
        <Select value={shift} onValueChange={onShiftChange}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="whole-day">Whole Day (8:00 AM – 5:00 PM)</SelectItem>
            <SelectItem value="morning">Morning (8:00 AM – 12:00 PM)</SelectItem>
            <SelectItem value="afternoon">Afternoon (1:00 PM – 5:00 PM)</SelectItem>
            <SelectItem value="custom">Custom Time Range</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {shift === "custom" && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>Start</Label>
            <Select value={start} onValueChange={onStartChange}>
              <SelectTrigger className="w-full" aria-invalid={!!errors.customStart}>
                <SelectValue placeholder="Start time" />
              </SelectTrigger>
              <SelectContent>
                {shopTimeOptions().map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.customStart} />
          </div>
          <div className="space-y-1">
            <Label>End</Label>
            <Select value={end} onValueChange={onEndChange}>
              <SelectTrigger className="w-full" aria-invalid={!!errors.customEnd}>
                <SelectValue placeholder="End time" />
              </SelectTrigger>
              <SelectContent>
                {shopTimeOptions().map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldError message={errors.customEnd} />
          </div>
        </div>
      )}
    </>
  );
}

/** The bookings a shift change moves to another mechanic. */
function ShiftWorkNotice({
  loading,
  failed,
  affected,
  emptyMessage,
}: {
  loading: boolean;
  failed: boolean;
  affected: ShiftWork[];
  emptyMessage: string;
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Checking this mechanic's
        bookings...
      </p>
    );
  }
  if (failed) {
    return (
      <InlineAlert className="mb-0">
        Could not check this mechanic's bookings. Close this and try again.
      </InlineAlert>
    );
  }
  if (affected.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <p className="font-medium text-foreground">
        {affected.length === 1
          ? "This booking moves to another free mechanic:"
          : `These ${affected.length} bookings move to other free mechanics:`}
      </p>
      <ul className="mt-2 space-y-1 text-muted-foreground">
        {affected.map((item) => (
          <li key={item.key}>
            {formatTime(item.startTime)} · {item.customerName} · {item.referenceCode}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">
        If no one else is free for one of them, nothing changes.
      </p>
    </div>
  );
}
