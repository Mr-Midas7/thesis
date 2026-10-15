import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { format } from "date-fns";
import {
  Archive,
  CalendarRange,
  ChevronDown,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import type { DateRange } from "react-day-picker";

import {
  AdminPage,
  DataList,
  InlineAlert,
  ListCard,
  ListEmpty,
  ListToolbar,
  ResetFiltersButton,
  ToolbarFilters,
  ToolbarSearch,
} from "@/components/admin/data-list";
import { PageHeader } from "@/components/admin/page-header";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import {
  calendarRangeToIso,
  formatShortDate,
  isoDateToCalendarDate,
  manilaMonthDateRange,
  manilaWeekDateRange,
  startOfManilaDay,
  startOfNextManilaDay,
} from "@/lib/admin-date-range";
import {
  COMPLETED_APPOINTMENT_KEPT,
  decodeBlockReason,
  formatDateLong,
  formatPHP,
  formatTime,
  manilaNow,
  normalizePhilippineMobile,
  statusLabel,
  statusTone,
  toLocalPhilippineMobile,
} from "@/lib/shop";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/archive")({
  component: ArchivePage,
});

const ARCHIVE_TABS = [
  { value: "appointments", label: "Appointments" },
  { value: "services", label: "Services" },
  { value: "products", label: "Products" },
  { value: "motorcycles", label: "Motorcycles" },
  { value: "crew", label: "Pit Crew" },
  { value: "blocks", label: "Schedule Blocks" },
  { value: "blocked-numbers", label: "Blocked Numbers" },
] as const;

const APPOINTMENT_STATUSES = [
  "pending",
  "confirmed",
  "completed",
  "cancelled",
  "rejected",
  "no_show",
];

type ArchiveFilters = {
  term: string;
  datePeriod: ArchiveDatePeriod;
  dateFrom: string;
  dateTo: string;
  customDateFrom: string;
  customDateTo: string;
  status: string;
};

type ArchiveDatePeriod = "all" | "today" | "week" | "month" | "custom";

type ArchiveItemType =
  "appointment" | "service" | "product" | "motorcycle" | "crew" | "block" | "blockedNumber";

type ArchiveActionTarget = {
  id: string;
  type: ArchiveItemType;
  label: string;
};

const ARCHIVE_ITEM_LABELS: Record<ArchiveItemType, string> = {
  appointment: "appointment",
  service: "service",
  product: "product",
  motorcycle: "motorcycle catalog item",
  crew: "pit crew member",
  block: "schedule block",
  blockedNumber: "blocked number",
};

const EMPTY_FILTERS: ArchiveFilters = {
  term: "",
  datePeriod: "all",
  dateFrom: "",
  dateTo: "",
  customDateFrom: "",
  customDateTo: "",
  status: "all",
};

function ArchivePage() {
  const pageSize = 10;
  const queryClient = useQueryClient();
  const [draftFilters, setDraftFilters] = useState<ArchiveFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<ArchiveFilters>(EMPTY_FILTERS);
  const [activeTab, setActiveTab] = useState("appointments");
  const [page, setPage] = useState(0);
  const [restoreTarget, setRestoreTarget] = useState<ArchiveActionTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ArchiveActionTarget | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const deferredTerm = useDeferredValue(filters.term);
  const cleanedSearchTerm = cleanSearchTerm(deferredTerm);
  const searchTerm = normalizePhilippineMobile(cleanedSearchTerm) ?? cleanedSearchTerm;

  const archived = useQuery({
    queryKey: ["archived-appointments", { searchTerm, filters, page }],
    queryFn: async () => {
      let query = supabase
        .from("appointments")
        .select("*", { count: "exact" })
        .eq("is_archived", true)
        .order("appointment_date", { ascending: false });
      if (searchTerm)
        query = query.or(
          `reference_code.ilike.%${searchTerm}%,customer_name.ilike.%${searchTerm}%,phone.ilike.%${searchTerm}%,plate_number.ilike.%${searchTerm}%`,
        );
      if (filters.status !== "all") query = query.eq("status", filters.status);
      if (filters.dateFrom) query = query.gte("appointment_date", filters.dateFrom);
      if (filters.dateTo) query = query.lte("appointment_date", filters.dateTo);
      const { data, error, count } = await query.range(
        page * pageSize,
        page * pageSize + pageSize - 1,
      );
      if (error) throw error;
      return { rows: data ?? [], total: count ?? 0 };
    },
  });

  const archivedServices = useQuery({
    queryKey: ["archived-services", { searchTerm, filters, page }],
    queryFn: async () => {
      let query = supabase
        .from("services")
        .select("*", { count: "exact" })
        .eq("is_archived", true)
        .order("sort_order");
      if (searchTerm) query = query.ilike("name", `%${searchTerm}%`);
      if (filters.dateFrom) query = query.gte("created_at", startOfManilaDay(filters.dateFrom));
      if (filters.dateTo) query = query.lt("created_at", startOfNextManilaDay(filters.dateTo));
      const { data, error, count } = await query.range(
        page * pageSize,
        page * pageSize + pageSize - 1,
      );
      if (error) throw error;
      return { rows: data ?? [], total: count ?? 0 };
    },
  });

  const archivedProducts = useQuery({
    queryKey: ["archived-products", { searchTerm, filters, page }],
    queryFn: async () => {
      let query = supabase
        .from("products")
        .select("*", { count: "exact" })
        .in("category", ["part", "accessory"])
        .eq("is_archived", true)
        .order("sort_order");
      if (searchTerm) query = query.or(`name.ilike.%${searchTerm}%,brand.ilike.%${searchTerm}%`);
      if (filters.dateFrom) query = query.gte("created_at", startOfManilaDay(filters.dateFrom));
      if (filters.dateTo) query = query.lt("created_at", startOfNextManilaDay(filters.dateTo));
      const { data, error, count } = await query.range(
        page * pageSize,
        page * pageSize + pageSize - 1,
      );
      if (error) throw error;
      return { rows: data ?? [], total: count ?? 0 };
    },
  });

  const archivedMotorcycles = useQuery({
    queryKey: ["archived-motorcycles", { searchTerm, filters, page }],
    queryFn: async () => {
      let query = supabase
        .from("motorcycle_catalog")
        .select("*", { count: "exact" })
        .eq("is_archived", true)
        .order("brand")
        .order("model");
      if (searchTerm) query = query.or(`model.ilike.%${searchTerm}%,brand.ilike.%${searchTerm}%`);
      if (filters.dateFrom) query = query.gte("created_at", startOfManilaDay(filters.dateFrom));
      if (filters.dateTo) query = query.lt("created_at", startOfNextManilaDay(filters.dateTo));
      const { data, error, count } = await query.range(
        page * pageSize,
        page * pageSize + pageSize - 1,
      );
      if (error) throw error;
      return { rows: data ?? [], total: count ?? 0 };
    },
  });

  const archivedCrew = useQuery({
    queryKey: ["archived-crew", { searchTerm, filters, page }],
    queryFn: async () => {
      let query = supabase
        .from("crew_members")
        .select("*", { count: "exact" })
        .eq("is_archived", true)
        .order("name");
      if (searchTerm)
        query = query.or(
          `name.ilike.%${searchTerm}%,role.ilike.%${searchTerm}%,phone.ilike.%${searchTerm}%`,
        );
      if (filters.dateFrom) query = query.gte("created_at", startOfManilaDay(filters.dateFrom));
      if (filters.dateTo) query = query.lt("created_at", startOfNextManilaDay(filters.dateTo));
      const { data, error, count } = await query.range(
        page * pageSize,
        page * pageSize + pageSize - 1,
      );
      if (error) throw error;
      return { rows: data ?? [], total: count ?? 0 };
    },
  });

  const archivedBlocks = useQuery({
    queryKey: ["archived-blocks", { searchTerm, filters, page }],
    queryFn: async () => {
      let query = supabase
        .from("schedule_blocks")
        .select("*", { count: "exact" })
        .eq("is_active", false)
        .order("block_date", { ascending: false });
      if (searchTerm) query = query.ilike("reason", `%${searchTerm}%`);
      if (filters.dateFrom) query = query.gte("block_date", filters.dateFrom);
      if (filters.dateTo) query = query.lte("block_date", filters.dateTo);
      const { data, error, count } = await query.range(
        page * pageSize,
        page * pageSize + pageSize - 1,
      );
      if (error) throw error;
      return { rows: data ?? [], total: count ?? 0 };
    },
  });

  const archivedBlockedNumbers = useQuery({
    queryKey: ["archived-blocked-numbers", { searchTerm, filters, page }],
    queryFn: async () => {
      let query = supabase
        .from("blocked_numbers")
        .select("*", { count: "exact" })
        .eq("is_archived", true)
        .order("created_at", { ascending: false });
      if (searchTerm) query = query.or(`phone.ilike.%${searchTerm}%,reason.ilike.%${searchTerm}%`);
      if (filters.dateFrom) query = query.gte("created_at", startOfManilaDay(filters.dateFrom));
      if (filters.dateTo) query = query.lt("created_at", startOfNextManilaDay(filters.dateTo));
      const { data, error, count } = await query.range(
        page * pageSize,
        page * pageSize + pageSize - 1,
      );
      if (error) throw error;
      return { rows: data ?? [], total: count ?? 0 };
    },
  });

  const restoreAppointment = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("appointments")
        .update({ is_archived: false })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["archived-appointments"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-appointments"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-dashboard"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Restore failed:", err);
      setActionError("Could not restore this appointment. Please try again.");
    },
  });

  const restoreService = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("services").update({ is_archived: false }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["archived-services"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-services"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Restore failed:", err);
      setActionError("Could not restore this service. Please try again.");
    },
  });

  const restoreProduct = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("products").update({ is_archived: false }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["archived-products"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-products"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Restore failed:", err);
      setActionError("Could not restore this product. Please try again.");
    },
  });

  const restoreMotorcycle = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("motorcycle_catalog")
        .update({ is_archived: false })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["archived-motorcycles"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-motorcycle-catalog"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["motorcycle-catalog"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-service-model-catalog"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Restore failed:", err);
      setActionError("Could not restore this motorcycle catalog item. Please try again.");
    },
  });

  const restoreCrew = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("crew_members")
        .update({ is_archived: false })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["archived-crew"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["crew-all"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Restore failed:", err);
      setActionError("Could not restore this crew member. Please try again.");
    },
  });

  const restoreBlock = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("schedule_blocks")
        .update({ is_active: true })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["archived-blocks"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["schedule-blocks"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Restore failed:", err);
      setActionError("Could not restore this schedule block. Please try again.");
    },
  });

  const restoreBlockedNumber = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("blocked_numbers")
        .update({ is_archived: false })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["archived-blocked-numbers"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["blocked-numbers"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Restore failed:", err);
      setActionError("Could not restore this blocked number. Please try again.");
    },
  });

  const deleteItem = useMutation({
    mutationFn: async ({ id, type }: Pick<ArchiveActionTarget, "id" | "type">) => {
      const tables: Record<ArchiveItemType, string> = {
        appointment: "appointments",
        service: "services",
        product: "products",
        motorcycle: "motorcycle_catalog",
        crew: "crew_members",
        block: "schedule_blocks",
        blockedNumber: "blocked_numbers",
      };
      const table = tables[type] as
        | "appointments"
        | "services"
        | "products"
        | "motorcycle_catalog"
        | "crew_members"
        | "schedule_blocks"
        | "blocked_numbers";
      if (!table) throw new Error(`Unknown type: ${type}`);
      const { error } = await supabase.from(table).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setDeleteTarget(null);
      setActionError(null);
      queryClient.invalidateQueries({ queryKey: ["archived-appointments"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["archived-services"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["archived-products"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["archived-motorcycles"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["archived-crew"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["archived-blocks"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["archived-blocked-numbers"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-appointments"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-dashboard"], exact: false });
      // The customer list is derived from appointment history. Refresh it after
      // a permanent appointment deletion so a customer with no appointments
      // is removed immediately.
      queryClient.invalidateQueries({ queryKey: ["customers"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["customer-history"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-services"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-products"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["crew-all"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["schedule-blocks"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["blocked-numbers"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["motorcycle-catalog"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Delete failed:", err);
      setActionError(
        err.message.includes("Completed appointments")
          ? COMPLETED_APPOINTMENT_KEPT
          : "Could not permanently delete this item. Please try again.",
      );
    },
  });

  const appointmentRows = archived.data?.rows ?? [];
  const serviceRows = archivedServices.data?.rows ?? [];
  const productRows = archivedProducts.data?.rows ?? [];
  const motorcycleRows = archivedMotorcycles.data?.rows ?? [];
  const crewRows = archivedCrew.data?.rows ?? [];
  const blockRows = archivedBlocks.data?.rows ?? [];
  const blockedNumberRows = archivedBlockedNumbers.data?.rows ?? [];
  const archiveCounts: Record<string, number> = {
    appointments: archived.data?.total ?? 0,
    services: archivedServices.data?.total ?? 0,
    products: archivedProducts.data?.total ?? 0,
    motorcycles: archivedMotorcycles.data?.total ?? 0,
    crew: archivedCrew.data?.total ?? 0,
    blocks: archivedBlocks.data?.total ?? 0,
    "blocked-numbers": archivedBlockedNumbers.data?.total ?? 0,
  };
  const activeArchive = {
    appointments: archived.data,
    services: archivedServices.data,
    products: archivedProducts.data,
    motorcycles: archivedMotorcycles.data,
    crew: archivedCrew.data,
    blocks: archivedBlocks.data,
    "blocked-numbers": archivedBlockedNumbers.data,
  }[activeTab];

  useEffect(() => {
    const total = activeArchive?.total ?? 0;
    const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);
    if (page > lastPage) setPage(lastPage);
  }, [activeArchive?.total, page, pageSize]);

  const confirmRestore = (target: ArchiveActionTarget) => {
    setRestoreTarget(target);
  };

  const confirmDelete = (target: ArchiveActionTarget) => {
    setDeleteTarget(target);
  };

  const handleRestore = () => {
    const target = restoreTarget;
    if (!target) return;

    setRestoreTarget(null);
    switch (target.type) {
      case "appointment":
        restoreAppointment.mutate(target.id);
        break;
      case "service":
        restoreService.mutate(target.id);
        break;
      case "product":
        restoreProduct.mutate(target.id);
        break;
      case "motorcycle":
        restoreMotorcycle.mutate(target.id);
        break;
      case "crew":
        restoreCrew.mutate(target.id);
        break;
      case "block":
        restoreBlock.mutate(target.id);
        break;
      case "blockedNumber":
        restoreBlockedNumber.mutate(target.id);
        break;
    }
  };

  const handleDelete = () => {
    if (deleteTarget) {
      deleteItem.mutate(deleteTarget);
    }
  };

  const applyFilters = () => {
    setFilters({ ...draftFilters });
    setPage(0);
  };

  const resetFilters = () => {
    setDraftFilters(EMPTY_FILTERS);
    setFilters(EMPTY_FILTERS);
    setPage(0);
  };

  const setArchiveType = (value: string) => {
    if (!ARCHIVE_TABS.some((tab) => tab.value === value)) return;
    setActiveTab(value);
    setPage(0);
  };

  const hasAppliedFilters =
    Boolean(filters.term.trim()) || filters.datePeriod !== "all" || filters.status !== "all";

  const rowActions = (target: ArchiveActionTarget, kept = false) => (
    <ArchiveRowActions
      label={target.label}
      onRestore={() => confirmRestore(target)}
      onDelete={() => confirmDelete(target)}
      kept={kept}
    />
  );
  const loadError = (
    query: { isError: boolean; refetch: () => unknown },
    label: string,
  ): { message: string; onRetry: () => void } | null =>
    query.isError
      ? { message: `Could not load archived ${label}.`, onRetry: () => void query.refetch() }
      : null;
  const emptyState = (label: string) => (
    <ListEmpty
      icon={Archive}
      title={
        hasAppliedFilters ? `No archived ${label} match your filters.` : `No archived ${label}.`
      }
      description={
        hasAppliedFilters
          ? "Try a different search or date range."
          : "Archived records stay here for 30 days before they are deleted automatically."
      }
      action={hasAppliedFilters ? <ResetFiltersButton onClick={resetFilters} /> : undefined}
    />
  );

  return (
    <AdminPage>
      <PageHeader
        title="Archive"
        description="Restore archived bookings, services, products, crew, schedule blocks, and blocked numbers, or delete them permanently. Archived records are deleted automatically after 30 days, except completed appointments, which are kept for financial records."
      />
      {actionError && <InlineAlert>{actionError}</InlineAlert>}

      <Tabs value={activeTab} onValueChange={setArchiveType}>
        <TabsList className="mb-4">
          {ARCHIVE_TABS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value} className="gap-1.5">
              {tab.label}
              <span className="rounded-full bg-foreground/10 px-1.5 text-xs tabular-nums">
                {archiveCounts[tab.value]}
              </span>
            </TabsTrigger>
          ))}
        </TabsList>

        <ListToolbar
          summary={
            activeArchive &&
            `${activeArchive.total} archived ${activeArchive.total === 1 ? "record" : "records"}${hasAppliedFilters ? " match your filters" : ""}`
          }
        >
          <ToolbarSearch
            id="archive-search"
            value={draftFilters.term}
            onChange={(term) => setDraftFilters((current) => ({ ...current, term }))}
            onEnter={applyFilters}
            placeholder="Search name, customer, or reference"
            label="Search archived records"
          />
          <ToolbarFilters>
            <div className="col-span-2 sm:w-56">
              <ArchiveDateRangeFilter
                period={draftFilters.datePeriod}
                dateFrom={draftFilters.dateFrom}
                dateTo={draftFilters.dateTo}
                customDateFrom={draftFilters.customDateFrom}
                customDateTo={draftFilters.customDateTo}
                onPeriodChange={(datePeriod) =>
                  setDraftFilters((current) => ({ ...current, datePeriod }))
                }
                onDateRangeChange={(dateFrom, dateTo) =>
                  setDraftFilters((current) => ({ ...current, dateFrom, dateTo }))
                }
                onCustomDateRangeChange={(customDateFrom, customDateTo) =>
                  setDraftFilters((current) => ({ ...current, customDateFrom, customDateTo }))
                }
              />
            </div>
            {activeTab === "appointments" && (
              <Select
                value={draftFilters.status}
                onValueChange={(value) =>
                  setDraftFilters((current) => ({ ...current, status: value }))
                }
              >
                <SelectTrigger
                  aria-label="Filter by appointment status"
                  className="col-span-2 w-full sm:w-40"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {APPOINTMENT_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {statusLabel(status)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button type="button" onClick={applyFilters}>
              <SlidersHorizontal /> Apply filters
            </Button>
            <Button type="button" variant="outline" onClick={resetFilters}>
              <RotateCcw /> Reset
            </Button>
          </ToolbarFilters>
        </ListToolbar>

        <ListCard
          footer={
            <PaginationControls
              page={page}
              pageSize={pageSize}
              total={activeArchive?.total ?? 0}
              onPageChange={setPage}
            />
          }
        >
          <TabsContent value="appointments" className="mt-0">
            <DataList
              label="Archived appointments"
              rows={appointmentRows}
              rowKey={(a) => a.id}
              loading={archived.isLoading}
              error={loadError(archived, "appointments")}
              empty={emptyState("appointments")}
              columns={[
                {
                  key: "customer",
                  header: "Customer",
                  card: "title",
                  cell: (a) => (
                    <>
                      <p className="font-medium">{a.customer_name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <span className="font-mono">{a.reference_code}</span> · {a.moto_brand}{" "}
                        {a.moto_model} · {a.plate_number}
                      </p>
                    </>
                  ),
                },
                {
                  key: "schedule",
                  header: "Schedule",
                  className: "w-40",
                  cell: (a) => (
                    <span className="text-sm">
                      {formatDateLong(a.appointment_date)}
                      <span className="block text-xs text-muted-foreground">
                        {formatTime(String(a.start_time).slice(0, 5))}
                      </span>
                    </span>
                  ),
                },
                {
                  key: "estimate",
                  header: "Estimate",
                  xlOnly: true,
                  className: "w-28 text-right",
                  cell: (a) => <span className="text-sm">{formatPHP(a.total_estimate)}</span>,
                },
                {
                  key: "status",
                  header: "Status",
                  card: "badge",
                  className: "w-28 text-center",
                  cell: (a) => (
                    <Badge variant="outline" className={cn("uppercase", statusTone(a.status))}>
                      {statusLabel(a.status)}
                    </Badge>
                  ),
                },
              ]}
              actionsClassName="w-56"
              actions={(a) =>
                rowActions(
                  { id: a.id, type: "appointment", label: a.reference_code },
                  a.status === "completed",
                )
              }
            />
          </TabsContent>

          <TabsContent value="services" className="mt-0">
            <DataList
              label="Archived services"
              rows={serviceRows}
              rowKey={(s) => s.id}
              loading={archivedServices.isLoading}
              error={loadError(archivedServices, "services")}
              empty={emptyState("services")}
              columns={[
                {
                  key: "service",
                  header: "Service",
                  card: "title",
                  cell: (s) => (
                    <>
                      <p className="font-medium">{s.name}</p>
                      <div className="mt-1 text-xs text-muted-foreground">
                        <ArchiveServiceDetails
                          serviceId={s.id}
                          serviceName={s.name}
                          description={s.description}
                        />
                      </div>
                    </>
                  ),
                },
                {
                  key: "price",
                  header: "Price",
                  className: "w-28 text-right",
                  cell: (s) => <span className="text-sm text-primary">{formatPHP(s.price)}</span>,
                },
                {
                  key: "duration",
                  header: "Duration",
                  className: "w-28",
                  cell: (s) => <span className="text-sm">{s.duration_minutes} min</span>,
                },
              ]}
              actionsClassName="w-56"
              actions={(s) => rowActions({ id: s.id, type: "service", label: s.name })}
            />
          </TabsContent>

          <TabsContent value="products" className="mt-0">
            <DataList
              label="Archived products"
              rows={productRows}
              rowKey={(p) => p.id}
              loading={archivedProducts.isLoading}
              error={loadError(archivedProducts, "products")}
              empty={emptyState("products")}
              columns={[
                {
                  key: "item",
                  header: "Item",
                  card: "title",
                  cell: (p) => (
                    <>
                      <p className="font-medium">{p.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        <span className="capitalize">{p.category}</span>
                        {p.brand ? ` · ${p.brand}` : ""}
                      </p>
                    </>
                  ),
                },
                {
                  key: "price",
                  header: "Price",
                  className: "w-28 text-right",
                  cell: (p) => <span className="text-sm text-primary">{formatPHP(p.price)}</span>,
                },
              ]}
              actionsClassName="w-56"
              actions={(p) => rowActions({ id: p.id, type: "product", label: p.name })}
            />
          </TabsContent>

          <TabsContent value="motorcycles" className="mt-0">
            <DataList
              label="Archived motorcycles"
              rows={motorcycleRows}
              rowKey={(m) => m.id}
              loading={archivedMotorcycles.isLoading}
              error={loadError(archivedMotorcycles, "motorcycles")}
              empty={emptyState("motorcycles")}
              columns={[
                {
                  key: "model",
                  header: "Model",
                  card: "title",
                  cell: (m) => (
                    <>
                      <p className="font-medium">{m.model}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {m.brand ?? "No brand"}
                      </p>
                    </>
                  ),
                },
                {
                  key: "engine",
                  header: "Engine",
                  className: "w-28 text-right",
                  cell: (m) =>
                    m.engine_cc === null ? (
                      <span className="text-sm text-muted-foreground">Not set</span>
                    ) : (
                      <span className="text-sm">{m.engine_cc}cc</span>
                    ),
                },
              ]}
              actionsClassName="w-56"
              actions={(m) =>
                rowActions({
                  id: m.id,
                  type: "motorcycle",
                  label: `${m.brand ?? ""} ${m.model}`.trim(),
                })
              }
            />
          </TabsContent>

          <TabsContent value="crew" className="mt-0">
            <DataList
              label="Archived crew members"
              rows={crewRows}
              rowKey={(c) => c.id}
              loading={archivedCrew.isLoading}
              error={loadError(archivedCrew, "crew members")}
              empty={emptyState("crew members")}
              columns={[
                {
                  key: "name",
                  header: "Name",
                  card: "title",
                  cell: (c) => (
                    <>
                      <p className="font-medium">{c.name}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">{c.role}</p>
                    </>
                  ),
                },
                {
                  key: "phone",
                  header: "Phone",
                  className: "w-40",
                  cell: (c) =>
                    c.phone ? (
                      <span className="text-sm">{toLocalPhilippineMobile(c.phone)}</span>
                    ) : (
                      <span className="text-sm text-muted-foreground">Not set</span>
                    ),
                },
              ]}
              actionsClassName="w-56"
              actions={(c) => rowActions({ id: c.id, type: "crew", label: c.name })}
            />
          </TabsContent>

          <TabsContent value="blocks" className="mt-0">
            <DataList
              label="Archived schedule blocks"
              rows={blockRows}
              rowKey={(b) => b.id}
              loading={archivedBlocks.isLoading}
              error={loadError(archivedBlocks, "schedule blocks")}
              empty={emptyState("schedule blocks")}
              columns={[
                {
                  key: "date",
                  header: "Date",
                  card: "title",
                  className: "w-48",
                  cell: (b) => <span className="font-medium">{formatDateLong(b.block_date)}</span>,
                },
                {
                  key: "slot",
                  header: "Time",
                  className: "w-40",
                  cell: (b) => <span className="text-sm">{archivedBlockSlotLabel(b)}</span>,
                },
                {
                  key: "reason",
                  header: "Reason",
                  card: "wide",
                  cell: (b) => (
                    <span className="text-sm text-muted-foreground">
                      {decodeBlockReason(b.reason).userReason || "No reason given"}
                    </span>
                  ),
                },
              ]}
              actionsClassName="w-56"
              actions={(b) =>
                rowActions({
                  id: b.id,
                  type: "block",
                  label:
                    decodeBlockReason(b.reason).userReason.trim() || formatDateLong(b.block_date),
                })
              }
            />
          </TabsContent>

          <TabsContent value="blocked-numbers" className="mt-0">
            <DataList
              label="Archived blocked numbers"
              rows={blockedNumberRows}
              rowKey={(n) => n.id}
              loading={archivedBlockedNumbers.isLoading}
              error={loadError(archivedBlockedNumbers, "blocked numbers")}
              empty={emptyState("blocked numbers")}
              columns={[
                {
                  key: "phone",
                  header: "Phone",
                  card: "title",
                  className: "w-44",
                  cell: (n) => (
                    <span className="font-mono text-sm font-medium">
                      {toLocalPhilippineMobile(n.phone)}
                    </span>
                  ),
                },
                {
                  key: "reason",
                  header: "Reason",
                  card: "wide",
                  cell: (n) => (
                    <span className="text-sm text-muted-foreground">
                      {n.reason || "No reason given"}
                    </span>
                  ),
                },
                {
                  key: "created",
                  header: "Blocked on",
                  className: "w-36",
                  cell: (n) => <span className="text-sm">{formatShortDate(n.created_at)}</span>,
                },
              ]}
              actionsClassName="w-56"
              actions={(n) =>
                rowActions({
                  id: n.id,
                  type: "blockedNumber",
                  label: toLocalPhilippineMobile(n.phone),
                })
              }
            />
          </TabsContent>
        </ListCard>
      </Tabs>

      <AlertDialog open={!!restoreTarget} onOpenChange={(open) => !open && setRestoreTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Restore {restoreTarget && ARCHIVE_ITEM_LABELS[restoreTarget.type]}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Restore <span className="font-medium text-foreground">{restoreTarget?.label}</span> to
              the active {restoreTarget && ARCHIVE_ITEM_LABELS[restoreTarget.type]} list? It will be
              available in the corresponding admin module again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestore}>Restore</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Permanently delete {deleteTarget && ARCHIVE_ITEM_LABELS[deleteTarget.type]}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium text-foreground">{deleteTarget?.label}</span> will be
              removed permanently from the database. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDelete}
            >
              Permanently Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminPage>
  );
}

function cleanSearchTerm(value: string) {
  return value
    .trim()
    .replace(/[,%_()]/g, " ")
    .replace(/\s+/g, " ");
}

function ArchiveDateRangeFilter({
  period,
  dateFrom,
  dateTo,
  customDateFrom,
  customDateTo,
  onPeriodChange,
  onDateRangeChange,
  onCustomDateRangeChange,
}: {
  period: ArchiveDatePeriod;
  dateFrom: string;
  dateTo: string;
  customDateFrom: string;
  customDateTo: string;
  onPeriodChange: (period: ArchiveDatePeriod) => void;
  onDateRangeChange: (dateFrom: string, dateTo: string) => void;
  onCustomDateRangeChange: (dateFrom: string, dateTo: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [isPickingCustomRange, setIsPickingCustomRange] = useState(false);
  const [draftRange, setDraftRange] = useState<DateRange>();
  const selectedRange = customDateFrom
    ? {
        from: isoDateToCalendarDate(customDateFrom),
        to: customDateTo ? isoDateToCalendarDate(customDateTo) : undefined,
      }
    : undefined;

  const selectPeriod = (nextPeriod: Exclude<ArchiveDatePeriod, "all" | "custom">) => {
    const range = buildArchiveDateRange(nextPeriod);
    onDateRangeChange(range.from, range.to);
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
    onDateRangeChange(range.from, range.to);
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
          aria-label="Select archive date range"
          title={archiveDatePeriodLabel(period, dateFrom, dateTo)}
          className="w-full justify-between gap-2 px-3 text-left font-normal"
        >
          <span className="flex min-w-0 items-center gap-2 truncate">
            <CalendarRange className="size-4 shrink-0" aria-hidden="true" />
            <span className={cn(period === "all" && "text-muted-foreground")}>
              {archiveDatePeriodLabel(period, dateFrom, dateTo)}
            </span>
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
              <ArchiveDateRangeValue label="Start date" value={draftRange?.from} />
              <ArchiveDateRangeValue label="End date" value={draftRange?.to} />
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
              Archive date
            </p>
            <ArchiveDateOption
              active={period === "today"}
              label="Today"
              onClick={() => selectPeriod("today")}
            />
            <ArchiveDateOption
              active={period === "week"}
              label="This Week"
              onClick={() => selectPeriod("week")}
            />
            <ArchiveDateOption
              active={period === "month"}
              label="This Month"
              onClick={() => selectPeriod("month")}
            />
            <ArchiveDateOption
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

function ArchiveDateOption({
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

function ArchiveDateRangeValue({ label, value }: { label: string; value: Date | undefined }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-2 py-1.5">
      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-0.5 truncate font-medium text-foreground">
        {value ? format(value, "MMM d, yyyy") : "Not selected"}
      </p>
    </div>
  );
}

function buildArchiveDateRange(period: Exclude<ArchiveDatePeriod, "all" | "custom">): {
  from: string;
  to: string;
} {
  const today = manilaNow().date;

  if (period === "today") return { from: today, to: today };
  if (period === "week") {
    return manilaWeekDateRange(today);
  }

  return manilaMonthDateRange(today);
}

function archiveDatePeriodLabel(period: ArchiveDatePeriod, dateFrom: string, dateTo: string) {
  if (period === "all") return "Date range";
  if (period === "today") return "Today";
  if (period === "week") return "This Week";
  if (period === "month") return "This Month";
  return dateFrom ? formatDateRange(dateFrom, dateTo) : "Custom Date Range";
}

function formatDateRange(from: string, to: string) {
  if (!from) return "Select date range";

  const fromDate = isoDateToCalendarDate(from);
  const fromLabel = format(fromDate, "MMM d, yyyy");
  if (!to) return `${fromLabel} – Select end date`;

  const toDate = isoDateToCalendarDate(to);
  return fromDate.getFullYear() === toDate.getFullYear()
    ? `${format(fromDate, "MMM d")} – ${format(toDate, "MMM d, yyyy")}`
    : `${fromLabel} – ${format(toDate, "MMM d, yyyy")}`;
}

/** Restore and Delete. Records that are kept (completed appointments) have no Delete. */
function ArchiveRowActions({
  label,
  onRestore,
  onDelete,
  kept,
}: {
  label: string;
  onRestore: () => void;
  onDelete: () => void;
  kept: boolean;
}) {
  return (
    <>
      <Button size="sm" variant="outline" onClick={onRestore} aria-label={`Restore ${label}`}>
        <RotateCcw /> Restore
      </Button>
      {kept ? (
        <span className="w-20 text-left text-[11px] leading-tight text-muted-foreground">
          Kept for financial records
        </span>
      ) : (
        <Button
          size="sm"
          variant="destructive"
          onClick={onDelete}
          aria-label={`Permanently delete ${label}`}
        >
          <Trash2 /> Delete
        </Button>
      )}
    </>
  );
}

/** "Whole day", or the archived block’s time range. */
function archivedBlockSlotLabel(block: { start_time: string | null; reason: string | null }) {
  if (!block.start_time) return "Whole day";
  const start = formatTime(String(block.start_time).slice(0, 5));
  const { endTime } = decodeBlockReason(block.reason);
  return endTime ? `${start} – ${formatTime(endTime.slice(0, 5))}` : start;
}

function ArchiveServiceDetails({
  serviceId,
  serviceName,
  description,
}: {
  serviceId: string;
  serviceName: string;
  description: string | null;
}) {
  const detailsRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const details = description?.trim() ?? "";
  const detailsId = `archive-service-details-${serviceId}`;

  useEffect(() => {
    const element = detailsRef.current;
    if (!element || !details) return;

    const checkOverflow = () => {
      if (!expanded) setCanExpand(element.scrollHeight > element.clientHeight + 1);
    };

    checkOverflow();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(checkOverflow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [details, expanded]);

  if (!details) return "-";

  return (
    <div className="w-full max-w-[22rem] text-left">
      <p
        id={detailsId}
        ref={detailsRef}
        className={cn("break-words whitespace-pre-wrap", !expanded && "line-clamp-3")}
      >
        {details}
      </p>
      {canExpand && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mt-1 h-auto p-0 text-xs"
          onClick={() => setExpanded((current) => !current)}
          aria-controls={detailsId}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} details for ${serviceName}`}
        >
          {expanded ? "See Less" : "See More"}
        </Button>
      )}
    </div>
  );
}
