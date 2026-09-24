import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Archive, CalendarRange, ChevronDown } from "lucide-react";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";
import { z } from "zod";
import { format, parseISO } from "date-fns";

import { PageHeader } from "@/components/admin/page-header";
import { ArchiveConfirmationDialog } from "@/components/admin/archive-confirmation-dialog";
import { ActiveFilterChips } from "@/components/admin/active-filter-chips";
import { PaginationControls } from "@/components/admin/pagination-controls";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field-error";
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
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import {
  type Availability,
  computeAvailableDates,
  computeAvailableSlots,
  computeFullyBookedDates,
} from "@/lib/availability";
import { getAvailability } from "@/lib/booking.functions";
import {
  APPOINTMENT_STATUSES,
  addDays,
  formatDateLong,
  formatPHP,
  formatTime,
  intervalsOverlap,
  manilaNow,
  normalizePhilippineMobile,
  PHONE_VALIDATION_MESSAGE,
  sanitizePhilippineMobileInput,
  statusLabel,
  statusTone,
  timeToMinutes,
  toLocalPhilippineMobile,
} from "@/lib/shop";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/appointments")({
  validateSearch: z.object({
    appointmentId: z.string().uuid().optional(),
  }),
  component: AppointmentsPage,
});

type AppointmentDatePeriod = "all" | "today" | "7d" | "month" | "year" | "custom";
type IsoDateRange = { from: string; to: string };
const EMPTY_SERVICE_IDS: string[] = [];
type AppointmentService = Pick<
  Database["public"]["Tables"]["appointment_services"]["Row"],
  "service_id" | "service_name" | "price" | "duration_minutes"
>;
type RescheduleHistoryEntry = {
  id: string;
  appointment_id: string;
  new_appointment_id: string | null;
  reschedule_number: number;
  from_date: string;
  from_start_time: string;
  to_date: string | null;
  to_start_time: string | null;
  reason: string;
  decision: string;
  approved_at: string;
};
type AppointmentDetails = Database["public"]["Tables"]["appointments"]["Row"] & {
  appointment_services: AppointmentService[];
  crew_members: { name: string } | null;
};
type EditableService = Pick<
  Database["public"]["Tables"]["services"]["Row"],
  "id" | "name" | "price" | "duration_minutes"
>;
type AppointmentEditForm = {
  firstName: string;
  middleName: string;
  lastName: string;
  phone: string;
  serviceIds: string[];
  appointmentDate: string;
  startTime: string;
  assignedCrewId: string;
  crewAssignmentManual: boolean;
  status: string;
  adminNotes: string;
};
type AppointmentEditErrors = Partial<
  Record<
    | "firstName"
    | "middleName"
    | "lastName"
    | "phone"
    | "services"
    | "appointmentDate"
    | "startTime"
    | "schedule"
    | "assignedCrew"
    | "status"
    | "form",
    string
  >
>;

function AppointmentServicesList({
  appointmentId,
  services,
}: {
  appointmentId: string;
  services: AppointmentService[];
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const serviceListRef = useRef<HTMLDivElement>(null);
  const serviceListId = `appointment-services-${appointmentId}`;
  const canCollapse = services.length > 1;

  useEffect(() => {
    if (!canCollapse) {
      setIsTruncated(false);
      return;
    }

    if (isExpanded) return;

    const list = serviceListRef.current;
    if (!list) return;

    const updateTruncation = () => {
      setIsTruncated(list.scrollHeight > list.clientHeight + 1);
    };

    updateTruncation();
    const resizeObserver = new ResizeObserver(updateTruncation);
    resizeObserver.observe(list);

    return () => resizeObserver.disconnect();
  }, [canCollapse, isExpanded, services]);

  return (
    <div className="min-w-0 md:max-w-72">
      <div
        ref={serviceListRef}
        id={serviceListId}
        className={cn(
          "space-y-0.5 leading-4",
          canCollapse && !isExpanded && "max-h-[2.25rem] overflow-hidden",
        )}
      >
        {services.map((service) => (
          <span key={service.service_id ?? service.service_name} className="block">
            {service.service_name}
          </span>
        ))}
      </div>
      {canCollapse && isTruncated && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mt-0.5 h-auto min-h-0 px-0 py-0 text-xs"
          aria-controls={serviceListId}
          aria-expanded={isExpanded}
          onClick={() => setIsExpanded((expanded) => !expanded)}
        >
          {isExpanded ? "See Less" : "See More"}
        </Button>
      )}
    </div>
  );
}

function appointmentEditHasChanges(
  appointment: AppointmentDetails,
  form: AppointmentEditForm,
): boolean {
  const originalServiceIds = appointment.appointment_services
    .map((service) => service.service_id)
    .filter((serviceId): serviceId is string => Boolean(serviceId));

  return (
    form.firstName.trim() !== (appointment.first_name ?? "").trim() ||
    form.middleName.trim() !== (appointment.middle_name ?? "").trim() ||
    form.lastName.trim() !== (appointment.last_name ?? "").trim() ||
    normalizePhilippineMobile(form.phone) !== normalizePhilippineMobile(appointment.phone) ||
    [...form.serviceIds].sort().join(",") !== [...originalServiceIds].sort().join(",") ||
    form.appointmentDate !== appointment.appointment_date ||
    form.startTime !== String(appointment.start_time).slice(0, 5) ||
    form.assignedCrewId !== (appointment.assigned_crew_id ?? "none") ||
    form.status !== appointment.status ||
    form.adminNotes.trim() !== (appointment.admin_notes ?? "").trim()
  );
}

function appointmentScheduleHasChanged(
  appointment: AppointmentDetails,
  form: AppointmentEditForm,
): boolean {
  return (
    form.appointmentDate !== appointment.appointment_date ||
    form.startTime !== String(appointment.start_time).slice(0, 5)
  );
}

function AppointmentsPage() {
  const pageSize = 10;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const availabilityFn = useServerFn(getAvailability);
  const search = Route.useSearch();
  const [status, setStatus] = useState("all");
  const [term, setTerm] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editForm, setEditForm] = useState<AppointmentEditForm | null>(null);
  const [editErrors, setEditErrors] = useState<AppointmentEditErrors>({});
  const [pendingSaveForm, setPendingSaveForm] = useState<AppointmentEditForm | null>(null);
  const [datePeriod, setDatePeriod] = useState<AppointmentDatePeriod>("all");
  const [customDateRange, setCustomDateRange] = useState<DateRange>();
  const [page, setPage] = useState(0);
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const focusedAppointmentId = search.appointmentId;
  const deferredTerm = useDeferredValue(term);
  const dateRange = useMemo(
    () => buildAppointmentDateRange(datePeriod, customDateRange),
    [customDateRange, datePeriod],
  );
  const dateFilterKey = dateRange ? `${dateRange.from}:${dateRange.to}` : "all";

  const appointments = useQuery({
    queryKey: [
      "admin-appointments",
      { focusedAppointmentId, status, term: deferredTerm, dateFilterKey, page },
    ],
    queryFn: async () => {
      let query = supabase
        .from("appointments")
        .select(
          "*, appointment_services(service_id, service_name, price, duration_minutes), crew_members(name)",
          {
            count: "exact",
          },
        )
        .eq("is_archived", false)
        .order("appointment_date", { ascending: false })
        .order("start_time");

      if (focusedAppointmentId) {
        query = query.eq("id", focusedAppointmentId);
      } else {
        if (status !== "all") query = query.eq("status", status);
        if (dateRange) {
          query = query
            .gte("appointment_date", dateRange.from)
            .lte("appointment_date", dateRange.to);
        }
        if (deferredTerm.trim()) {
          const cleanedTerm = cleanSearchTerm(deferredTerm);
          const value = normalizePhilippineMobile(cleanedTerm) ?? cleanedTerm;
          query = query.or(
            `reference_code.ilike.%${value}%,customer_name.ilike.%${value}%,phone.ilike.%${value}%,plate_number.ilike.%${value}%`,
          );
        }
        query = query.range(page * pageSize, page * pageSize + pageSize - 1);
      }

      const { data, error, count } = await query;
      if (error) throw error;
      return { rows: data ?? [], total: count ?? 0 };
    },
  });

  const crew = useQuery({
    queryKey: ["crew"],
    queryFn: async () => {
      const { data } = await supabase
        .from("crew_members")
        .select("*")
        .eq("is_active", true)
        .eq("is_archived", false)
        .order("name");
      return Array.from(new Map((data ?? []).map((c) => [c.name.trim(), c])).values());
    },
  });

  const services = useQuery({
    queryKey: ["admin-appointment-edit-services"],
    queryFn: async (): Promise<EditableService[]> => {
      const { data, error } = await supabase
        .from("services")
        .select("id, name, price, duration_minutes")
        .eq("is_active", true)
        .eq("is_archived", false)
        .order("sort_order");
      if (error) throw error;
      return data;
    },
  });

  const editServiceIds = editForm?.serviceIds ?? EMPTY_SERVICE_IDS;
  const appointmentAvailability = useQuery<Availability>({
    queryKey: [
      "admin-appointment-availability",
      { appointmentId: openId, serviceIds: editServiceIds },
    ],
    queryFn: () =>
      availabilityFn({
        data: {
          days: 45,
          serviceIds: editServiceIds,
          excludeAppointmentId: openId ?? undefined,
        },
      }),
    enabled: isEditing && Boolean(openId) && editServiceIds.length > 0,
    staleTime: 5_000,
  });

  const availableAppointmentDates = useMemo(
    () => (appointmentAvailability.data ? computeAvailableDates(appointmentAvailability.data) : []),
    [appointmentAvailability.data],
  );
  const availableAppointmentDateSet = useMemo(
    () => new Set(availableAppointmentDates),
    [availableAppointmentDates],
  );
  const editableAppointmentDate = editForm?.appointmentDate ?? "";
  const availableAppointmentSlots = useMemo(
    () =>
      appointmentAvailability.data && editableAppointmentDate
        ? computeAvailableSlots(appointmentAvailability.data, editableAppointmentDate)
        : [],
    [appointmentAvailability.data, editableAppointmentDate],
  );
  const fullyBookedAppointmentDates = useMemo(
    () =>
      appointmentAvailability.data ? computeFullyBookedDates(appointmentAvailability.data) : [],
    [appointmentAvailability.data],
  );
  const editableAppointmentDuration = useMemo(
    () =>
      editServiceIds.length > 0
        ? editServiceIds.reduce(
            (total, serviceId) =>
              total +
              (services.data?.find((service) => service.id === serviceId)?.duration_minutes ?? 60),
            30,
          )
        : 0,
    [editServiceIds, services.data],
  );
  const assignableCrew = useQuery({
    queryKey: [
      "admin-appointment-assignable-crew",
      {
        appointmentId: openId,
        date: editableAppointmentDate,
        startTime: editForm?.startTime ?? "",
        duration: editableAppointmentDuration,
      },
    ],
    queryFn: async () => {
      const startMinutes = timeToMinutes(editForm?.startTime ?? "");
      const endMinutes = startMinutes + editableAppointmentDuration;
      let appointmentsQuery = supabase
        .from("appointments")
        .select("id, assigned_crew_id, start_time, booking_duration_minutes")
        .eq("appointment_date", editableAppointmentDate)
        .eq("is_archived", false)
        .is("rescheduled_to_appointment_id", null)
        .not("status", "in", "(cancelled,rejected,no_show)");
      if (openId) appointmentsQuery = appointmentsQuery.neq("id", openId);

      const [schedules, exceptions, appointments] = await Promise.all([
        supabase
          .from("crew_schedules")
          .select("crew_id, start_time, end_time, is_working")
          .eq("schedule_date", editableAppointmentDate)
          .eq("is_working", true),
        supabase
          .from("crew_availability_exceptions")
          .select("crew_id, start_time, end_time, is_all_day")
          .lte("start_date", editableAppointmentDate)
          .gte("end_date", editableAppointmentDate),
        appointmentsQuery,
      ]);

      if (schedules.error || exceptions.error || appointments.error) {
        throw schedules.error ?? exceptions.error ?? appointments.error;
      }

      return (crew.data ?? []).filter((member) => {
        const schedule = schedules.data?.find(
          (item) => item.crew_id === member.id && item.start_time && item.end_time,
        );
        if (!schedule) return false;

        const shiftStart = timeToMinutes(String(schedule.start_time).slice(0, 5));
        const shiftEnd = timeToMinutes(String(schedule.end_time).slice(0, 5));
        if (startMinutes < shiftStart || endMinutes > shiftEnd) return false;

        const hasException = (exceptions.data ?? []).some((exception) => {
          if (exception.crew_id !== member.id) return false;
          if (exception.is_all_day) return true;
          if (!exception.start_time || !exception.end_time) return false;
          return intervalsOverlap(
            startMinutes,
            endMinutes,
            timeToMinutes(String(exception.start_time).slice(0, 5)),
            timeToMinutes(String(exception.end_time).slice(0, 5)),
          );
        });
        if (hasException) return false;

        return !(appointments.data ?? []).some((appointment) => {
          if (appointment.assigned_crew_id !== member.id) return false;
          const appointmentStart = timeToMinutes(String(appointment.start_time).slice(0, 5));
          return intervalsOverlap(
            startMinutes,
            endMinutes,
            appointmentStart,
            appointmentStart + (appointment.booking_duration_minutes ?? 75),
          );
        });
      });
    },
    enabled:
      isEditing &&
      Boolean(openId) &&
      Boolean(editableAppointmentDate) &&
      Boolean(editForm?.startTime) &&
      editableAppointmentDuration > 0 &&
      !services.isLoading &&
      !crew.isLoading,
  });
  const assignableCrewIds = useMemo(
    () => new Set((assignableCrew.data ?? []).map((member) => member.id)),
    [assignableCrew.data],
  );

  const saveAppointment = useMutation({
    mutationFn: async ({ id, form }: { id: string; form: AppointmentEditForm }) => {
      const { error } = await supabase.rpc("update_appointment_details_atomic", {
        p_appointment_id: id,
        p_service_ids: form.serviceIds,
        p_appointment_date: form.appointmentDate,
        p_start_time: form.startTime,
        p_assigned_crew_id: form.assignedCrewId === "none" ? null : form.assignedCrewId,
        p_crew_assignment_manual: form.crewAssignmentManual,
        p_status: form.status,
        p_admin_notes: form.adminNotes.trim() || null,
        p_first_name: form.firstName.trim(),
        p_middle_name: form.middleName.trim(),
        p_last_name: form.lastName.trim(),
        p_phone: normalizePhilippineMobile(form.phone)!,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setIsEditing(false);
      setEditErrors({});
      setPendingSaveForm(null);
      qc.invalidateQueries({ queryKey: ["admin-appointments"], exact: false });
      qc.invalidateQueries({ queryKey: ["admin-dashboard"], exact: false });
      qc.invalidateQueries({ queryKey: ["archived-appointments"], exact: false });
      qc.invalidateQueries({ queryKey: ["notifications"] });
      qc.invalidateQueries({ queryKey: ["unread-notifications"] });
    },
    onError: (err: Error) => {
      setEditErrors((current) => ({
        ...current,
        ...errorsForAppointmentUpdate(err),
      }));
    },
  });

  const archive = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("appointments")
        .update({ is_archived: true } as never)
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setArchiveError(null);
      qc.invalidateQueries({ queryKey: ["admin-appointments"], exact: false });
      qc.invalidateQueries({ queryKey: ["admin-dashboard"], exact: false });
      qc.invalidateQueries({ queryKey: ["archived-appointments"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Archive failed:", err);
      setArchiveError("Could not archive this appointment. Please try again.");
    },
  });

  useEffect(() => {
    setOpenId(focusedAppointmentId ?? null);
    setPage(0);
  }, [focusedAppointmentId]);

  useEffect(() => {
    setPage(0);
  }, [dateFilterKey, status, term]);

  const rows = appointments.data?.rows ?? [];
  const typedRows = rows as AppointmentDetails[];
  const selectedAppointment = typedRows.find((appointment) => appointment.id === openId) ?? null;

  const rescheduleHistory = useQuery({
    queryKey: ["appointment-reschedule-history", openId],
    queryFn: async () => {
      if (!openId) return [];
      const { data, error } = await supabase
        .from("appointment_reschedule_history")
        .select(
          "id, from_date, from_start_time, to_date, to_start_time, reason, decision, reschedule_number, approved_at",
        )
        .eq("appointment_id", openId)
        .order("reschedule_number", { ascending: true });
      if (error) throw error;
      return (data ?? []) as RescheduleHistoryEntry[];
    },
    enabled: Boolean(openId),
    staleTime: 5_000,
  });
  const hasEditChanges = Boolean(
    selectedAppointment && editForm && appointmentEditHasChanges(selectedAppointment, editForm),
  );
  const scheduleHasChanged = Boolean(
    selectedAppointment && editForm && appointmentScheduleHasChanged(selectedAppointment, editForm),
  );
  const activeFilters = [
    ...(term.trim() ? [{ label: "Search", value: term.trim(), onClear: () => setTerm("") }] : []),
    ...(status !== "all"
      ? [{ label: "Status", value: statusLabel(status), onClear: () => setStatus("all") }]
      : []),
    ...(dateRange
      ? [
          {
            label: "Date",
            value: appointmentDatePeriodLabel(datePeriod, dateRange),
            onClear: () => {
              setDatePeriod("all");
              setCustomDateRange(undefined);
            },
          },
        ]
      : []),
  ];

  function resetFilters() {
    setTerm("");
    setStatus("all");
    setDatePeriod("all");
    setCustomDateRange(undefined);
    setPage(0);
  }

  function closeAppointmentDialog() {
    setOpenId(null);
    setIsEditing(false);
    setEditForm(null);
    setEditErrors({});
    setPendingSaveForm(null);
  }

  function startEditing(appointment: AppointmentDetails) {
    setEditForm({
      firstName: appointment.first_name ?? "",
      middleName: appointment.middle_name ?? "",
      lastName: appointment.last_name ?? "",
      phone: toLocalPhilippineMobile(appointment.phone),
      serviceIds: appointment.appointment_services
        .map((service) => service.service_id)
        .filter((serviceId): serviceId is string => Boolean(serviceId)),
      appointmentDate: appointment.appointment_date,
      startTime: String(appointment.start_time).slice(0, 5),
      assignedCrewId: appointment.assigned_crew_id ?? "none",
      crewAssignmentManual: false,
      status: appointment.status,
      adminNotes: appointment.admin_notes ?? "",
    });
    setEditErrors({});
    setPendingSaveForm(null);
    setIsEditing(true);
  }

  function toggleService(serviceId: string, selected: boolean) {
    setEditForm((current) =>
      current
        ? {
            ...current,
            serviceIds: selected
              ? [...current.serviceIds, serviceId]
              : current.serviceIds.filter((id) => id !== serviceId),
            assignedCrewId: "none",
            crewAssignmentManual: false,
          }
        : current,
    );
    clearAppointmentEditErrors("services", "schedule", "form");
  }

  function clearAppointmentEditErrors(...keys: Array<keyof AppointmentEditErrors>) {
    setEditErrors((current) => {
      const next = { ...current };
      keys.forEach((key) => delete next[key]);
      return next;
    });
  }

  function handleSaveAppointment() {
    if (!selectedAppointment || !editForm) return;

    if (!hasEditChanges) {
      setEditErrors({ form: "No changes detected. Update at least one appointment detail first." });
      return;
    }

    const nextErrors: AppointmentEditErrors = {};
    if (editForm.firstName.trim().length < 2) {
      nextErrors.firstName = "Enter a valid first name.";
    }
    if (editForm.lastName.trim().length < 2) {
      nextErrors.lastName = "Enter a valid last name.";
    }
    if (!normalizePhilippineMobile(editForm.phone)) {
      nextErrors.phone = PHONE_VALIDATION_MESSAGE;
    }
    if (editForm.serviceIds.length === 0) {
      nextErrors.services = "Select at least one service.";
    }
    if (!editForm.appointmentDate) {
      nextErrors.appointmentDate = "Select an appointment date.";
    }
    if (!editForm.startTime) {
      nextErrors.startTime = "Select an appointment time.";
    }
    const statusChanged = editForm.status !== selectedAppointment.status;
    if (
      statusChanged &&
      editForm.status === "completed" &&
      !selectedAppointment.service_started_at
    ) {
      nextErrors.status = "Start the service before marking the appointment completed.";
    }
    if (
      statusChanged &&
      editForm.status === "no_show" &&
      (selectedAppointment.service_started_at ||
        selectedAppointment.arrival_notification_snooze_count < 3)
    ) {
      nextErrors.status = "Mark an appointment as no-show only after three arrival snoozes.";
    }

    if (scheduleHasChanged) {
      if (appointmentAvailability.isLoading) {
        nextErrors.schedule = "Available schedules are still loading. Please wait a moment.";
      } else if (appointmentAvailability.isError || appointmentAvailability.data?.error) {
        nextErrors.schedule =
          appointmentAvailability.data?.error ??
          "We could not verify available schedules. Please try again.";
      } else if (!availableAppointmentDateSet.has(editForm.appointmentDate)) {
        nextErrors.appointmentDate = "Choose an available appointment date.";
      } else if (
        !availableAppointmentSlots.some(
          (slot) => slot.startTime === editForm.startTime && !slot.disabled,
        )
      ) {
        nextErrors.startTime = "Choose an available appointment time.";
      }
    }

    const crewSelectionChanged =
      editForm.assignedCrewId !== (selectedAppointment.assigned_crew_id ?? "none");
    const confirmingAppointment =
      editForm.status === "confirmed" && editForm.status !== selectedAppointment.status;
    if (scheduleHasChanged || crewSelectionChanged || confirmingAppointment) {
      if (editForm.assignedCrewId !== "none") {
        if (assignableCrew.isLoading) {
          nextErrors.assignedCrew = "Checking crew availability. Please wait a moment.";
        } else if (assignableCrew.isError || !assignableCrewIds.has(editForm.assignedCrewId)) {
          nextErrors.assignedCrew =
            "Choose a crew member who is free for the full appointment period.";
        }
      } else if (editForm.status === "confirmed" && !editForm.crewAssignmentManual) {
        if (assignableCrew.isLoading) {
          nextErrors.assignedCrew = "Checking crew availability. Please wait a moment.";
        } else if (assignableCrew.isError || assignableCrewIds.size === 0) {
          nextErrors.assignedCrew = "No crew member is available for this appointment period.";
        }
      }
    }

    if (Object.keys(nextErrors).length > 0) {
      setEditErrors(nextErrors);
      return;
    }

    setPendingSaveForm({ ...editForm, serviceIds: [...editForm.serviceIds] });
  }

  function confirmSaveAppointment() {
    if (!selectedAppointment || !pendingSaveForm) return;
    const form = pendingSaveForm;
    setPendingSaveForm(null);
    saveAppointment.mutate({ id: selectedAppointment.id, form });
  }

  return (
    <div>
      <PageHeader
        title="Appointments Management"
        description={
          focusedAppointmentId
            ? "Showing the appointment selected from Notifications."
            : "Confirm, reschedule, assign crew and archive bookings."
        }
      />

      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          value={term}
          onChange={(e) => {
            setTerm(e.target.value);
            setPage(0);
          }}
          placeholder="Search reference, name, phone or plate"
          className="max-w-xs"
        />
        <Select
          value={status}
          onValueChange={(value) => {
            setStatus(value);
            setPage(0);
          }}
        >
          <SelectTrigger className="w-full sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {APPOINTMENT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {statusLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <AppointmentDateFilter
          period={datePeriod}
          customDateRange={customDateRange}
          onPeriodChange={(period) => {
            setDatePeriod(period);
            if (period === "all") setCustomDateRange(undefined);
          }}
          onCustomDateRangeChange={setCustomDateRange}
        />
        {focusedAppointmentId && (
          <Button
            variant="outline"
            onClick={() => navigate({ to: "/admin/appointments", search: {} })}
          >
            Show all appointments
          </Button>
        )}
      </div>
      <ActiveFilterChips filters={activeFilters} onReset={resetFilters} />
      {archiveError && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {archiveError}
        </p>
      )}

      <Card className="border-border/70 bg-card/60">
        <CardContent className="overflow-x-auto p-0">
          <Table className="admin-data-table">
            <TableHeader>
              <TableRow>
                <TableHead>Date Created</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Customer</TableHead>
                <TableHead>Services</TableHead>
                <TableHead>Schedule</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {typedRows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell
                    data-label="Booked on"
                    className="whitespace-nowrap text-xs text-muted-foreground"
                  >
                    {formatBookedOn(a.created_at)}
                  </TableCell>
                  <TableCell data-label="Reference" className="font-mono text-xs">
                    {a.reference_code}
                  </TableCell>
                  <TableCell data-label="Customer">
                    <span className="block text-sm">{a.customer_name}</span>
                    <span className="text-xs text-muted-foreground">
                      {toLocalPhilippineMobile(a.phone)}
                    </span>
                  </TableCell>
                  <TableCell data-label="Services" className="text-xs">
                    <AppointmentServicesList
                      appointmentId={a.id}
                      services={a.appointment_services}
                    />
                  </TableCell>
                  <TableCell data-label="Schedule" className="text-xs">
                    {formatDateLong(a.appointment_date)}
                    <span className="block text-muted-foreground">
                      {formatTime(String(a.start_time).slice(0, 5))}
                    </span>
                  </TableCell>
                  <TableCell data-label="Status">
                    <Badge variant="outline" className={cn("uppercase", statusTone(a.status))}>
                      {statusLabel(a.status)}
                    </Badge>
                  </TableCell>
                  <TableCell data-label="Actions" className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setOpenId(a.id);
                          setIsEditing(false);
                          setEditForm(null);
                          setEditErrors({});
                        }}
                      >
                        View
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Archive appointment ${a.reference_code}`}
                        title="Archive appointment"
                        onClick={() => setArchiveTarget(a.id)}
                      >
                        <Archive className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {rows.length === 0 && (
            <p className="p-8 text-center text-sm text-muted-foreground">
              {focusedAppointmentId
                ? "This appointment is no longer available."
                : "No appointments found."}
            </p>
          )}
          {!focusedAppointmentId && (
            <PaginationControls
              page={page}
              pageSize={pageSize}
              total={appointments.data?.total ?? 0}
              onPageChange={setPage}
            />
          )}
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(selectedAppointment)}
        onOpenChange={(open) => {
          if (!open) closeAppointmentDialog();
        }}
      >
        {selectedAppointment && (
          <DialogContent className="max-w-4xl">
            <DialogHeader>
              <DialogTitle className="font-display uppercase">Appointment details</DialogTitle>
              <DialogDescription>
                Reference{" "}
                <span className="font-mono text-foreground">
                  {selectedAppointment.reference_code}
                </span>
              </DialogDescription>
            </DialogHeader>

            {selectedAppointment.reschedule_count >= 3 && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-muted-foreground">
                <strong className="text-destructive">Maximum reschedule limit reached.</strong> This
                appointment has already been rescheduled 3 times. Its schedule can no longer be
                changed.
              </p>
            )}

            {isEditing && editForm ? (
              <div className="space-y-5">
                <AppointmentReadOnlyDetails appointment={selectedAppointment} hideName />

                <section className="space-y-3">
                  <div>
                    <h3 className="font-medium">Edit appointment</h3>
                    <p className="text-sm text-muted-foreground">
                      Update the service, schedule, crew assignment, status, and internal shop
                      notes.
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    {(
                      [
                        ["First Name", "firstName"],
                        ["Middle Name (Optional)", "middleName"],
                        ["Last Name", "lastName"],
                      ] as const
                    ).map(([label, field]) => (
                      <div key={field} className="space-y-1.5">
                        <Label htmlFor={`appointment-${field}`}>{label}</Label>
                        <Input
                          id={`appointment-${field}`}
                          value={editForm[field]}
                          maxLength={40}
                          onChange={(event) => {
                            setEditForm({
                              ...editForm,
                              [field]: event.target.value.replace(/[^a-zA-Z\s]/g, ""),
                            });
                            clearAppointmentEditErrors(field, "form");
                          }}
                          aria-invalid={Boolean(editErrors[field])}
                        />
                        <FieldError message={editErrors[field]} />
                      </div>
                    ))}
                    <div className="space-y-1.5">
                      <Label htmlFor="appointment-phone">Mobile number</Label>
                      <Input
                        id="appointment-phone"
                        type="tel"
                        value={editForm.phone}
                        maxLength={11}
                        inputMode="tel"
                        autoComplete="tel"
                        onChange={(event) => {
                          setEditForm({
                            ...editForm,
                            phone: sanitizePhilippineMobileInput(event.target.value),
                          });
                          clearAppointmentEditErrors("phone", "form");
                        }}
                        placeholder="09171234567"
                        aria-invalid={Boolean(editErrors.phone)}
                      />
                      <FieldError message={editErrors.phone} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Services</Label>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {services.data?.map((service) => {
                        const selected = editForm.serviceIds.includes(service.id);
                        return (
                          <label
                            key={service.id}
                            className={cn(
                              "flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm transition-colors",
                              selected && "border-primary bg-primary/5",
                            )}
                          >
                            <Checkbox
                              checked={selected}
                              onCheckedChange={(checked) =>
                                toggleService(service.id, checked === true)
                              }
                              aria-label={`Select ${service.name}`}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block font-medium">{service.name}</span>
                              <span className="text-xs text-muted-foreground">
                                {service.duration_minutes} mins · {formatPHP(service.price)}
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                    {services.isLoading && (
                      <p className="text-sm text-muted-foreground">Loading available services…</p>
                    )}
                    <FieldError message={editErrors.services} />
                  </div>

                  <div className="grid gap-4 lg:grid-cols-[auto_minmax(0,1fr)]">
                    <div className="space-y-1.5">
                      <Label>Appointment date</Label>
                      {appointmentAvailability.isLoading ? (
                        <div className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
                          Loading available dates…
                        </div>
                      ) : appointmentAvailability.isError || appointmentAvailability.data?.error ? (
                        <div className="rounded-lg border border-destructive/60 p-4 text-sm text-destructive">
                          {appointmentAvailability.data?.error ??
                            "We could not load available schedules. Please try again."}
                        </div>
                      ) : (
                        <div
                          className={cn(
                            "rounded-lg border border-border bg-card/50 p-2",
                            editErrors.appointmentDate && "border-destructive",
                          )}
                        >
                          <Calendar
                            mode="single"
                            selected={
                              editForm.appointmentDate
                                ? parseISO(editForm.appointmentDate)
                                : undefined
                            }
                            onSelect={(selectedDate) => {
                              if (!selectedDate) return;
                              const nextDate = format(selectedDate, "yyyy-MM-dd");
                              if (nextDate === editForm.appointmentDate) return;
                              setEditForm({
                                ...editForm,
                                appointmentDate: nextDate,
                                startTime: "",
                                assignedCrewId: "none",
                                crewAssignmentManual: false,
                              });
                              clearAppointmentEditErrors(
                                "appointmentDate",
                                "startTime",
                                "schedule",
                                "form",
                              );
                            }}
                            disabled={(date) =>
                              !availableAppointmentDateSet.has(format(date, "yyyy-MM-dd"))
                            }
                            modifiers={{
                              fullyBooked: fullyBookedAppointmentDates.map((value) =>
                                parseISO(value),
                              ),
                            }}
                            modifiersClassNames={{
                              fullyBooked:
                                "bg-destructive/15 text-destructive line-through opacity-100",
                            }}
                            classNames={{
                              nav: "justify-between gap-1",
                              month_caption:
                                "flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
                            }}
                          />
                        </div>
                      )}
                      <FieldError message={editErrors.appointmentDate} />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Appointment time</Label>
                      {editableAppointmentDate ? (
                        <div
                          className={cn(
                            "grid grid-cols-2 gap-2 sm:grid-cols-3",
                            editErrors.startTime && "rounded-lg ring-1 ring-destructive",
                          )}
                        >
                          {availableAppointmentSlots.map((slot) => (
                            <button
                              type="button"
                              key={slot.id}
                              disabled={slot.disabled}
                              onClick={() => {
                                if (slot.startTime === editForm.startTime) return;
                                setEditForm({
                                  ...editForm,
                                  startTime: slot.startTime,
                                  assignedCrewId: "none",
                                  crewAssignmentManual: false,
                                });
                                clearAppointmentEditErrors(
                                  "startTime",
                                  "schedule",
                                  "assignedCrew",
                                  "form",
                                );
                              }}
                              className={cn(
                                "rounded-lg border p-3 text-center transition-colors",
                                slot.disabled && "cursor-not-allowed opacity-40",
                                editForm.startTime === slot.startTime
                                  ? "border-primary bg-primary/15"
                                  : "border-border bg-card/50 hover:border-primary/50",
                              )}
                            >
                              <span className="font-display block">
                                {formatTime(slot.startTime)}
                              </span>
                              <span className="block text-[11px] text-muted-foreground">
                                {slot.disabled ? "Unavailable" : "Available"}
                              </span>
                            </button>
                          ))}
                          {availableAppointmentSlots.length === 0 &&
                            !appointmentAvailability.isLoading && (
                              <p className="col-span-full rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                                No available times for this date. Please choose another date.
                              </p>
                            )}
                        </div>
                      ) : (
                        <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                          Choose an available date to view available time slots.
                        </div>
                      )}
                      <FieldError message={editErrors.startTime} />
                    </div>
                  </div>
                  {fullyBookedAppointmentDates.length > 0 &&
                    !appointmentAvailability.isLoading &&
                    !appointmentAvailability.isError && (
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="h-3 w-3 rounded-sm bg-destructive/15 ring-1 ring-destructive/40" />
                        Fully booked dates cannot be selected.
                      </p>
                    )}
                  <FieldError message={editErrors.schedule} />

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label>Assigned crew</Label>
                      <Select
                        value={editForm.assignedCrewId}
                        disabled={assignableCrew.isLoading || assignableCrew.isError}
                        onValueChange={(assignedCrewId) => {
                          setEditForm({
                            ...editForm,
                            assignedCrewId,
                            crewAssignmentManual: true,
                          });
                          clearAppointmentEditErrors("assignedCrew", "form");
                        }}
                      >
                        <SelectTrigger aria-invalid={Boolean(editErrors.assignedCrew)}>
                          <SelectValue
                            placeholder={
                              assignableCrew.isLoading ? "Checking availability…" : "Unassigned"
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Unassigned</SelectItem>
                          {assignableCrew.data?.map((member) => (
                            <SelectItem key={member.id} value={member.id}>
                              {member.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {editForm.status === "confirmed" &&
                        editForm.assignedCrewId === "none" &&
                        !editForm.crewAssignmentManual && (
                          <p className="text-xs text-muted-foreground">
                            A free crew member will be assigned automatically when you save.
                          </p>
                        )}
                      <FieldError message={editErrors.assignedCrew} />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Status</Label>
                      <Select
                        value={editForm.status}
                        onValueChange={(status) => {
                          setEditForm({ ...editForm, status });
                          clearAppointmentEditErrors("status", "form");
                        }}
                      >
                        <SelectTrigger aria-invalid={Boolean(editErrors.status)}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {APPOINTMENT_STATUSES.map((appointmentStatus) => (
                            <SelectItem key={appointmentStatus} value={appointmentStatus}>
                              {statusLabel(appointmentStatus)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FieldError message={editErrors.status} />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="shop-notes">Shop notes</Label>
                    <Textarea
                      id="shop-notes"
                      value={editForm.adminNotes}
                      onChange={(event) =>
                        setEditForm({ ...editForm, adminNotes: event.target.value })
                      }
                      placeholder="Internal notes visible to shop staff only"
                      rows={4}
                    />
                  </div>
                  {!hasEditChanges && (
                    <p className="text-sm text-muted-foreground">
                      No changes to save. Update at least one appointment detail first.
                    </p>
                  )}
                  <FieldError message={editErrors.form} />
                </section>
              </div>
            ) : (
              <div className="space-y-5">
                <AppointmentReadOnlyDetails appointment={selectedAppointment} />
                <section className="rounded-lg border border-border/70 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-medium">Appointment</h3>
                    <Badge
                      variant="outline"
                      className={cn("uppercase", statusTone(selectedAppointment.status))}
                    >
                      {statusLabel(selectedAppointment.status)}
                    </Badge>
                  </div>
                  <div className="mt-3 grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <AppointmentDetail
                      label="Date"
                      value={formatDateLong(selectedAppointment.appointment_date)}
                    />
                    <AppointmentDetail
                      label="Time"
                      value={formatTime(String(selectedAppointment.start_time).slice(0, 5))}
                    />
                    <AppointmentDetail
                      label="Assigned crew"
                      value={selectedAppointment.crew_members?.name ?? "Unassigned"}
                    />
                    <AppointmentDetail
                      label="Booked on"
                      value={formatBookedOn(selectedAppointment.created_at)}
                    />
                    <AppointmentDetail
                      label="Reschedules"
                      value={`${selectedAppointment.reschedule_count} / 3`}
                    />
                  </div>
                </section>
                <ServiceProgress appointment={selectedAppointment} />
                {rescheduleHistory.data && rescheduleHistory.data.length > 0 && (
                  <section className="rounded-lg border border-border/70 p-4">
                    <h3 className="font-medium">Reschedule history</h3>
                    <div className="mt-3 divide-y divide-border/70 text-sm">
                      {rescheduleHistory.data.map((entry) => (
                        <div
                          key={entry.id}
                          className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">
                              {entry.reschedule_number === 1
                                ? "1st reschedule"
                                : entry.reschedule_number === 2
                                  ? "2nd reschedule"
                                  : entry.reschedule_number === 3
                                    ? "3rd reschedule"
                                    : `${entry.reschedule_number}th reschedule`}
                            </span>
                            <Badge
                              variant="outline"
                              className={
                                entry.decision === "confirmed"
                                  ? "border-emerald-500/30 text-emerald-600"
                                  : "border-destructive/40 text-destructive"
                              }
                            >
                              {entry.decision === "confirmed" ? "Approved" : "Rejected"}
                            </Badge>
                          </div>
                          <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                            <div>
                              <span className="font-medium text-foreground">From:</span>{" "}
                              {formatDateLong(entry.from_date)} at{" "}
                              {formatTime(String(entry.from_start_time).slice(0, 5))}
                            </div>
                            {entry.to_date && entry.to_start_time && (
                              <div>
                                <span className="font-medium text-foreground">To:</span>{" "}
                                {formatDateLong(entry.to_date)} at{" "}
                                {formatTime(String(entry.to_start_time).slice(0, 5))}
                              </div>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">Reason: {entry.reason}</p>
                          <p className="text-[10px] text-muted-foreground/70">
                            {formatBookedOn(entry.approved_at)}
                          </p>
                        </div>
                      ))}
                    </div>
                  </section>
                )}
                <section className="rounded-lg border border-border/70 p-4">
                  <h3 className="font-medium">Services</h3>
                  <div className="mt-3 divide-y divide-border/70 text-sm">
                    {selectedAppointment.appointment_services.map((service) => (
                      <div
                        key={service.service_name}
                        className="flex items-center justify-between gap-4 py-2"
                      >
                        <span>
                          {service.service_name}
                          <span className="ml-2 text-xs text-muted-foreground">
                            {service.duration_minutes} mins
                          </span>
                        </span>
                        <span className="text-primary">{formatPHP(service.price)}</span>
                      </div>
                    ))}
                    <div className="flex items-center justify-between gap-4 pt-3 font-medium">
                      <span>Total estimate</span>
                      <span className="text-primary">
                        {formatPHP(selectedAppointment.total_estimate)}
                      </span>
                    </div>
                  </div>
                </section>
                <section className="grid gap-4 sm:grid-cols-2">
                  <AppointmentDetail
                    className="rounded-lg border border-border/70 p-4"
                    label="Customer notes"
                    value={selectedAppointment.notes || "No customer notes provided."}
                  />
                  <AppointmentDetail
                    className="rounded-lg border border-border/70 p-4"
                    label="Shop notes"
                    value={selectedAppointment.admin_notes || "No shop notes added."}
                  />
                </section>
              </div>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeAppointmentDialog}>
                Close
              </Button>
              {isEditing ? (
                <Button
                  type="button"
                  onClick={handleSaveAppointment}
                  disabled={saveAppointment.isPending || !hasEditChanges}
                >
                  {saveAppointment.isPending ? "Saving…" : "Save"}
                </Button>
              ) : (
                <Button type="button" onClick={() => startEditing(selectedAppointment)}>
                  Edit
                </Button>
              )}
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
      <AlertDialog
        open={Boolean(pendingSaveForm)}
        onOpenChange={(open) => {
          if (!open && !saveAppointment.isPending) setPendingSaveForm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save appointment changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Confirm that the updated appointment details are correct. The appointment will only be
              changed after you confirm.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saveAppointment.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={saveAppointment.isPending}
              onClick={confirmSaveAppointment}
            >
              {saveAppointment.isPending ? "Saving…" : "Confirm changes"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ArchiveConfirmationDialog
        open={Boolean(archiveTarget)}
        recordLabel="appointment"
        pending={archive.isPending}
        onOpenChange={(nextOpen) => !nextOpen && setArchiveTarget(null)}
        onConfirm={() => {
          if (archiveTarget) archive.mutate(archiveTarget);
          setArchiveTarget(null);
        }}
      />
    </div>
  );
}

function AppointmentReadOnlyDetails({
  appointment,
  hideName = false,
}: {
  appointment: AppointmentDetails;
  hideName?: boolean;
}) {
  return (
    <section className="grid gap-4 rounded-lg border border-border/70 p-4 sm:grid-cols-2">
      <div>
        <h3 className="font-medium">Customer details</h3>
        <div className="mt-3 grid gap-3 text-sm">
          {!hideName && <AppointmentDetail label="Name" value={appointment.customer_name} />}
          <AppointmentDetail
            label="Contact number"
            value={toLocalPhilippineMobile(appointment.phone)}
          />
        </div>
      </div>
      <div>
        <h3 className="font-medium">Motorcycle details</h3>
        <div className="mt-3 grid gap-3 text-sm">
          <AppointmentDetail label="Brand" value={appointment.moto_brand} />
          <AppointmentDetail label="Model" value={appointment.moto_model} />
          <AppointmentDetail
            label="Variant / year"
            value={
              [appointment.moto_variant, appointment.moto_year].filter(Boolean).join(" · ") ||
              "Not provided"
            }
          />
          <AppointmentDetail label="Plate number" value={appointment.plate_number} />
        </div>
      </div>
    </section>
  );
}

function ServiceProgress({ appointment }: { appointment: AppointmentDetails }) {
  const serviceDurationMinutes = appointment.appointment_services.reduce(
    (total, service) => total + service.duration_minutes,
    0,
  );

  return (
    <section className="rounded-lg border border-border/70 p-4">
      <h3 className="font-medium">Service progress</h3>
      <div className="mt-3 grid gap-4 text-sm sm:grid-cols-3">
        <AppointmentDetail
          label="Service Start"
          value={
            appointment.service_started_at
              ? formatBookedOn(appointment.service_started_at)
              : "Not started"
          }
        />
        <AppointmentDetail
          label="Service End"
          value={
            appointment.service_ended_at
              ? formatBookedOn(appointment.service_ended_at)
              : "Not completed"
          }
        />
        <AppointmentDetail
          label="Service Duration"
          value={
            serviceDurationMinutes > 0
              ? formatServiceDuration(serviceDurationMinutes)
              : "Not available"
          }
        />
      </div>
    </section>
  );
}

function AppointmentDetail({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{value}</p>
    </div>
  );
}

function errorsForAppointmentUpdate(error: Error): AppointmentEditErrors {
  const message = error.message || "Could not save the appointment.";
  if (message.includes("appointments_crew_time_no_overlap")) {
    return {
      startTime:
        "This crew member already has an appointment that overlaps with the selected time.",
    };
  }
  if (message.includes("selected crew member")) {
    return { assignedCrew: "The selected crew member is not available for this appointment." };
  }
  if (
    message.includes("Start the service") ||
    message.includes("no-show") ||
    message.includes("completed service") ||
    message.includes("pre-service appointment")
  ) {
    return { status: message };
  }
  if (message.includes("service")) {
    return { services: "One or more selected services are not available." };
  }
  if (message.includes("status")) return { status: "Select a valid appointment status." };
  return { form: "Could not save this appointment. Please try again." };
}

function cleanSearchTerm(value: string) {
  return value
    .trim()
    .replace(/[,%_()]/g, " ")
    .replace(/\s+/g, " ");
}

function AppointmentDateFilter({
  period,
  customDateRange,
  onPeriodChange,
  onCustomDateRangeChange,
}: {
  period: AppointmentDatePeriod;
  customDateRange: DateRange | undefined;
  onPeriodChange: (period: AppointmentDatePeriod) => void;
  onCustomDateRangeChange: (range: DateRange | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [isPickingCustomRange, setIsPickingCustomRange] = useState(false);
  const [draftCustomDateRange, setDraftCustomDateRange] = useState<DateRange>();

  const selectPeriod = (nextPeriod: Exclude<AppointmentDatePeriod, "custom">) => {
    onPeriodChange(nextPeriod);
    setIsPickingCustomRange(false);
    setOpen(false);
  };

  const cancelCustomRange = () => {
    setDraftCustomDateRange(customDateRange);
    setIsPickingCustomRange(false);
    setOpen(false);
  };

  const applyCustomRange = () => {
    if (!draftCustomDateRange?.from || !draftCustomDateRange.to) return;
    onCustomDateRangeChange(draftCustomDateRange);
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
        <Button type="button" variant="outline" className="min-w-40 justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2 truncate">
            <CalendarRange className="size-4 shrink-0" aria-hidden="true" />
            {appointmentDatePeriodLabel(period, buildAppointmentDateRange(period, customDateRange))}
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
              selected={draftCustomDateRange}
              onSelect={setDraftCustomDateRange}
              className="mx-auto p-0"
              classNames={{
                nav: "inset-x-auto left-1/2 w-48 -translate-x-1/2 justify-between",
              }}
            />
            <div className="mt-2 grid grid-cols-2 gap-2 px-2 text-xs">
              <DateRangeValue label="Start date" value={draftCustomDateRange?.from} />
              <DateRangeValue label="End date" value={draftCustomDateRange?.to} />
            </div>
            <div className="mt-3 flex justify-end gap-2 border-t border-border pt-3">
              <Button type="button" variant="outline" size="sm" onClick={cancelCustomRange}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={applyCustomRange}
                disabled={!draftCustomDateRange?.from || !draftCustomDateRange.to}
              >
                Apply
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="px-2 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Appointment date
            </p>
            <AppointmentDateOption
              active={period === "all"}
              label="All dates"
              onClick={() => selectPeriod("all")}
            />
            <AppointmentDateOption
              active={period === "today"}
              label="Today"
              onClick={() => selectPeriod("today")}
            />
            <AppointmentDateOption
              active={period === "7d"}
              label="Last 7 days"
              onClick={() => selectPeriod("7d")}
            />
            <AppointmentDateOption
              active={period === "month"}
              label="This month"
              onClick={() => selectPeriod("month")}
            />
            <AppointmentDateOption
              active={period === "year"}
              label="This year"
              onClick={() => selectPeriod("year")}
            />
            <AppointmentDateOption
              active={period === "custom"}
              label="Custom date range"
              onClick={() => {
                setDraftCustomDateRange(customDateRange);
                setIsPickingCustomRange(true);
              }}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function AppointmentDateOption({
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

function DateRangeValue({ label, value }: { label: string; value: Date | undefined }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-2 py-1.5">
      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-0.5 truncate font-medium text-foreground">
        {value ? format(value, "MMM d, yyyy") : "Not selected"}
      </p>
    </div>
  );
}

function formatBookedOn(createdAt: string) {
  const date = new Date(createdAt);

  const datePart = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);

  const timePart = new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);

  return `${datePart.replace(/^([A-Za-z]{3})/, "$1.")} - ${timePart}`;
}

function formatServiceDuration(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (hours === 0) return `${remainingMinutes} min`;
  if (remainingMinutes === 0) return `${hours} hr`;
  return `${hours} hr ${remainingMinutes} min`;
}

function buildAppointmentDateRange(
  period: AppointmentDatePeriod,
  customRange?: DateRange,
): IsoDateRange | undefined {
  const today = manilaNow().date;
  const selectedDate = new Date(`${today}T12:00:00`);

  if (period === "today") return { from: today, to: today };
  if (period === "7d") return { from: addDays(today, -6), to: today };
  if (period === "month") {
    return {
      from: format(
        new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1, 12),
        "yyyy-MM-dd",
      ),
      to: format(
        new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 0, 12),
        "yyyy-MM-dd",
      ),
    };
  }
  if (period === "year") {
    return {
      from: format(new Date(selectedDate.getFullYear(), 0, 1, 12), "yyyy-MM-dd"),
      to: format(new Date(selectedDate.getFullYear(), 11, 31, 12), "yyyy-MM-dd"),
    };
  }
  if (period === "custom" && customRange?.from && customRange.to) {
    const from = format(customRange.from, "yyyy-MM-dd");
    const to = format(customRange.to, "yyyy-MM-dd");
    return from <= to ? { from, to } : { from: to, to: from };
  }
  return undefined;
}

function appointmentDatePeriodLabel(period: AppointmentDatePeriod, range?: IsoDateRange) {
  if (period === "all") return "All dates";
  if (period === "today") return "Today";
  if (period === "7d") return "Last 7 days";
  if (period === "month") return "This month";
  if (period === "year") return "This year";
  if (!range) return "Custom date range";
  return `${format(new Date(`${range.from}T12:00:00`), "MMM d")} – ${format(new Date(`${range.to}T12:00:00`), "MMM d, yyyy")}`;
}
