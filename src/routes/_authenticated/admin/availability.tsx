import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { format } from "date-fns";
import { CalendarRange, ChevronDown, Filter, Loader2, Plus, RotateCcw } from "lucide-react";
import { useMemo, useState } from "react";
import type { DateRange } from "react-day-picker";

import { PageHeader } from "@/components/admin/page-header";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field-error";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { formatDateLong, shopTimeOptions } from "@/lib/shop";
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
for (const [key, preset] of Object.entries(SHIFT_PRESETS)) {
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

function dateToKey(date: Date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateFromKey(value: string) {
  return new Date(`${value}T12:00:00`);
}

function assignmentPeriodBounds(filter: AssignmentFilter) {
  if (filter.period === "custom") {
    return { from: filter.customStart, to: filter.customEnd };
  }

  const today = new Date();
  if (filter.period === "monthly") {
    return {
      from: dateToKey(new Date(today.getFullYear(), today.getMonth(), 1)),
      to: dateToKey(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
    };
  }

  const mondayOffset = (today.getDay() + 6) % 7;
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - mondayOffset);
  return {
    from: dateToKey(monday),
    to: dateToKey(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)),
  };
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
    onCustomDateRangeChange(dateToKey(draftRange.from), dateToKey(draftRange.to));
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
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

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
        { onConflict: "crew_id,schedule_date", ignoreDuplicates: true },
      );
      if (error) throw error;
    },
    onSuccess: (_, payload) => {
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

  const deleteSchedule = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("crew_schedules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setActionError(null);
      qc.invalidateQueries({ queryKey: ["crew-schedules-all"] });
    },
    onError: (err: Error) => {
      const msg = err.message.toLowerCase();
      if (msg.includes("not found") || msg.includes("no rows")) {
        setActionError("This schedule no longer exists. Refresh the list and try again.");
      } else {
        console.error("Schedule delete failed:", err);
        setActionError("Could not remove this schedule. Please try again.");
      }
    },
  });

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

    const existingDates = new Set(
      (schedules.data ?? [])
        .filter((schedule) => schedule.crew_id === assignMechanic && schedule.schedule_date)
        .map((schedule) => schedule.schedule_date),
    );
    const newDateStrs = assignDateStrs.filter((date) => !existingDates.has(date));

    if (newDateStrs.length === 0) {
      setAssignmentErrors({ dates: "The mechanic is already assigned on each selected day." });
      return;
    }

    const skippedDays = assignDateStrs.length - newDateStrs.length;

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
        schedule_dates: newDateStrs,
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
      void skippedDays;
    } catch {
      // Error is shown inline by the mutation callback.
    }
  };

  return (
    <div>
      <PageHeader
        title="Crew Scheduling"
        description="Find and manage crew assignments by crew member, role, and period."
        action={
          <Button
            className="font-display uppercase"
            onClick={() => {
              setAssignMechanic("");
              setAssignShift("whole-day");
              setCustomStart("");
              setCustomEnd("");
              setAssignDates([]);
              setDialogOpen(true);
            }}
          >
            <Plus /> Assign crew
          </Button>
        }
      />
      {actionError && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {actionError}
        </p>
      )}

      <Card className="border-border/70 bg-card/60">
        <CardHeader>
          <CardTitle className="font-display text-lg tracking-wide uppercase">
            Crew Schedule Search
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4">
          <div className="grid gap-4 rounded-lg border border-border/70 bg-background/20 p-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="space-y-1.5">
              <Label>Crew member</Label>
              <Select value={filterCrewId} onValueChange={setFilterCrewId}>
                <SelectTrigger>
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
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={filterRole} onValueChange={setFilterRole}>
                <SelectTrigger>
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
            </div>
            <div className="space-y-1.5">
              <Label>Date range</Label>
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
            <div className="flex gap-2 xl:self-end">
              <Button
                type="button"
                className="flex-1 whitespace-nowrap xl:flex-none"
                onClick={applyAssignmentFilter}
              >
                <Filter /> Apply filters
              </Button>
              <Button
                type="button"
                variant="outline"
                className="flex-1 whitespace-nowrap xl:flex-none"
                onClick={clearAssignmentFilter}
              >
                <RotateCcw /> Reset
              </Button>
            </div>
            {filterPeriod === "custom" && (
              <div className="sm:col-span-2">
                <FieldError message={filterErrors.customStart ?? filterErrors.customEnd} />
              </div>
            )}
          </div>

          <div className="mt-5">
            {/* Day info panel — slides in from the left */}
            <div className="overflow-hidden">
              {filteredAssignments !== null ? (
                <div
                  key={JSON.stringify(appliedFilter)}
                  className="animate-in fade-in slide-in-from-bottom-2 duration-200"
                >
                  <Card className="border-border/70 bg-card/40">
                    <CardHeader>
                      <CardTitle className="font-display text-sm uppercase">
                        Crew assignments
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="p-4">
                      {filteredAssignments.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No crew assignments match this filter.
                        </p>
                      ) : (
                        <Table className="admin-data-table">
                          <TableHeader>
                            <TableRow>
                              <TableHead>Mechanic</TableHead>
                              <TableHead>Role</TableHead>
                              <TableHead>Date</TableHead>
                              <TableHead>Shift</TableHead>
                              <TableHead className="text-right">Action</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {filteredAssignments.map((w) => (
                              <TableRow key={w.id}>
                                <TableCell data-label="Mechanic" className="text-sm">
                                  {w.name}
                                </TableCell>
                                <TableCell data-label="Role" className="text-sm">
                                  {w.role}
                                </TableCell>
                                <TableCell data-label="Date" className="text-sm">
                                  {formatDateLong(w.schedule_date)}
                                </TableCell>
                                <TableCell data-label="Shift" className="text-xs">
                                  {w.start_time && w.end_time
                                    ? (PRESET_LABELS[`${w.start_time}|${w.end_time}`] ??
                                      `${w.start_time} - ${w.end_time}`)
                                    : "-"}
                                </TableCell>
                                <TableCell data-label="Action" className="text-right">
                                  {w.is_date_assignment && (
                                    <button
                                      type="button"
                                      onClick={() => setDeleteTarget(w.id)}
                                      className="rounded px-2 py-1 text-xs text-destructive hover:underline"
                                    >
                                      Remove assignment
                                    </button>
                                  )}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </CardContent>
                  </Card>
                </div>
              ) : (
                <div className="flex min-h-[120px] w-full items-center justify-center">
                  <p className="text-sm text-muted-foreground">
                    Choose your crew, role, and period, then apply the filter.
                  </p>
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(nextOpen) => !nextOpen && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this crew assignment?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the selected working-day assignment. You can add it again later if
              needed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteSchedule.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteSchedule.isPending}
              onClick={() => {
                if (deleteTarget) deleteSchedule.mutate(deleteTarget);
                setDeleteTarget(null);
              }}
            >
              Remove assignment
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

            <div className="space-y-1.5">
              <Label>Shift</Label>
              <Select
                value={assignShift}
                onValueChange={(v) => {
                  setAssignShift(v);
                  setCustomStart("");
                  setCustomEnd("");
                }}
              >
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

            {assignShift === "custom" && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Start</Label>
                  <Select
                    value={customStart}
                    onValueChange={(value) => {
                      setCustomStart(value);
                      setAssignmentErrors((current) => ({ ...current, customStart: undefined }));
                    }}
                  >
                    <SelectTrigger className="w-full" aria-invalid={!!assignmentErrors.customStart}>
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
                  <FieldError message={assignmentErrors.customStart} />
                </div>
                <div className="space-y-1">
                  <Label>End</Label>
                  <Select
                    value={customEnd}
                    onValueChange={(value) => {
                      setCustomEnd(value);
                      setAssignmentErrors((current) => ({ ...current, customEnd: undefined }));
                    }}
                  >
                    <SelectTrigger className="w-full" aria-invalid={!!assignmentErrors.customEnd}>
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
                  <FieldError message={assignmentErrors.customEnd} />
                </div>
              </div>
            )}
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
    </div>
  );
}
