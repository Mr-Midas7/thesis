import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { format } from "date-fns";
import { Archive, CalendarRange, RotateCcw, Search, SlidersHorizontal, Trash2 } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { toast } from "sonner";

import { PaginationControls } from "@/components/admin/pagination-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Calendar } from "@/components/ui/calendar";
import { FieldError } from "@/components/ui/field-error";
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
import { Input } from "@/components/ui/input";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { formatDateLong, formatPHP, formatTime, statusLabel, statusTone } from "@/lib/shop";
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
  dateFrom: string;
  dateTo: string;
  status: string;
};

const EMPTY_FILTERS: ArchiveFilters = {
  term: "",
  dateFrom: "",
  dateTo: "",
  status: "all",
};

function ArchivePage() {
  const pageSize = 10;
  const queryClient = useQueryClient();
  const [draftFilters, setDraftFilters] = useState<ArchiveFilters>(EMPTY_FILTERS);
  const [filters, setFilters] = useState<ArchiveFilters>(EMPTY_FILTERS);
  const [activeTab, setActiveTab] = useState("appointments");
  const [page, setPage] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; type: string } | null>(null);
  const [dateRangeOpen, setDateRangeOpen] = useState(false);
  const deferredTerm = useDeferredValue(filters.term);
  const searchTerm = cleanSearchTerm(deferredTerm);
  const selectedDateRange = draftFilters.dateFrom
    ? {
        from: dateFromIso(draftFilters.dateFrom),
        to: draftFilters.dateTo ? dateFromIso(draftFilters.dateTo) : undefined,
      }
    : undefined;
  const dateRangeError =
    draftFilters.dateFrom && draftFilters.dateTo && draftFilters.dateFrom > draftFilters.dateTo
      ? "The end date must be on or after the start date."
      : undefined;

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
      if (filters.dateTo) query = query.lte("created_at", endOfDay(filters.dateTo));
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
      if (filters.dateTo) query = query.lte("created_at", endOfDay(filters.dateTo));
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
      if (filters.dateTo) query = query.lte("created_at", endOfDay(filters.dateTo));
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
      if (filters.dateTo) query = query.lte("created_at", endOfDay(filters.dateTo));
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
      if (filters.dateTo) query = query.lte("created_at", endOfDay(filters.dateTo));
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
      toast.success("Appointment restored.");
      queryClient.invalidateQueries({ queryKey: ["archived-appointments"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-appointments"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-dashboard"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Restore failed:", err);
      toast.error(`Restore failed: ${err.message}`);
    },
  });

  const restoreService = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("services").update({ is_archived: false }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Service restored.");
      queryClient.invalidateQueries({ queryKey: ["archived-services"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-services"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Restore failed:", err);
      toast.error(`Restore failed: ${err.message}`);
    },
  });

  const restoreProduct = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("products").update({ is_archived: false }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Product restored.");
      queryClient.invalidateQueries({ queryKey: ["archived-products"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-products"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Restore failed:", err);
      toast.error(`Restore failed: ${err.message}`);
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
      toast.success("Motorcycle catalog item restored.");
      queryClient.invalidateQueries({ queryKey: ["archived-motorcycles"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-motorcycle-catalog"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["motorcycle-catalog"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["admin-service-model-catalog"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Restore failed:", err);
      toast.error(`Restore failed: ${err.message}`);
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
      toast.success("Crew member restored.");
      queryClient.invalidateQueries({ queryKey: ["archived-crew"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["crew-all"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Restore failed:", err);
      toast.error(`Restore failed: ${err.message}`);
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
      toast.success("Schedule block restored.");
      queryClient.invalidateQueries({ queryKey: ["archived-blocks"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["schedule-blocks"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Restore failed:", err);
      toast.error(`Restore failed: ${err.message}`);
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
      toast.success("Blocked number restored.");
      queryClient.invalidateQueries({ queryKey: ["archived-blocked-numbers"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["blocked-numbers"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Restore failed:", err);
      toast.error(`Restore failed: ${err.message}`);
    },
  });

  const deleteItem = useMutation({
    mutationFn: async ({ id, type }: { id: string; type: string }) => {
      const tables: Record<string, string> = {
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
      toast.success("Item permanently deleted.");
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
      toast.error(`Delete failed: ${err.message}`);
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

  const confirmDelete = (id: string, type: string) => {
    setDeleteTarget({ id, type });
  };

  const handleDelete = () => {
    if (deleteTarget) {
      deleteItem.mutate(deleteTarget);
    }
  };

  const applyFilters = () => {
    if (dateRangeError) return;
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

  return (
    <div>
      <header className="mb-6 flex items-start gap-3">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
          <Archive className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h1 className="font-display text-2xl tracking-wide uppercase md:text-3xl">Archive</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Archived bookings, services, products, crew, schedule blocks, and blocked numbers.
            Restore records or delete them permanently. Archived records are automatically deleted
            after 30 days.
          </p>
        </div>
      </header>

      <Card className="mb-5 border-border/70 bg-card/60">
        <CardContent className="p-4 sm:p-5">
          <div className="mb-4 flex items-center gap-2">
            <SlidersHorizontal className="size-4 text-primary" aria-hidden="true" />
            <h2 className="font-display text-base tracking-wide uppercase">Filter archive</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(12rem,1fr)_9rem_13rem_9rem_auto] xl:items-end">
            <div className="min-w-0 space-y-1.5">
              <label htmlFor="archive-search" className="text-xs font-medium text-muted-foreground">
                Search
              </label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <Input
                  id="archive-search"
                  value={draftFilters.term}
                  onChange={(event) =>
                    setDraftFilters((current) => ({ ...current, term: event.target.value }))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") applyFilters();
                  }}
                  placeholder="Search name, customer, or reference"
                  className="pl-9"
                />
              </div>
            </div>

            <div className="min-w-0 space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Type</label>
              <Select value={activeTab} onValueChange={setArchiveType}>
                <SelectTrigger aria-label="Archive record type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ARCHIVE_TABS.map((tab) => (
                    <SelectItem key={tab.value} value={tab.value}>
                      {tab.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="min-w-0 space-y-1.5">
              <label className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <CalendarRange className="size-3.5" aria-hidden="true" />
                Date range
              </label>
              <Popover open={dateRangeOpen} onOpenChange={setDateRangeOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    aria-invalid={Boolean(dateRangeError)}
                    aria-label="Select archive date range"
                    title={formatDateRange(draftFilters.dateFrom, draftFilters.dateTo)}
                    className="w-full justify-start px-3 text-left font-normal"
                  >
                    <CalendarRange className="mr-2 size-4 shrink-0 text-muted-foreground" />
                    <span
                      className={cn("truncate", !draftFilters.dateFrom && "text-muted-foreground")}
                    >
                      {formatDateRange(draftFilters.dateFrom, draftFilters.dateTo)}
                    </span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-auto max-w-[calc(100vw-2rem)] overflow-hidden p-0"
                >
                  <Calendar
                    mode="range"
                    selected={selectedDateRange}
                    {...(selectedDateRange?.from ? { defaultMonth: selectedDateRange.from } : {})}
                    numberOfMonths={2}
                    onSelect={(range) => {
                      setDraftFilters((current) => ({
                        ...current,
                        dateFrom: range?.from ? format(range.from, "yyyy-MM-dd") : "",
                        dateTo: range?.to ? format(range.to, "yyyy-MM-dd") : "",
                      }));
                    }}
                  />
                  <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
                    <span className="min-w-0 truncate text-xs text-muted-foreground">
                      {draftFilters.dateFrom
                        ? formatDateRange(draftFilters.dateFrom, draftFilters.dateTo)
                        : "Choose a start and end date"}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="shrink-0"
                      disabled={!draftFilters.dateFrom}
                      onClick={() =>
                        setDraftFilters((current) => ({
                          ...current,
                          dateFrom: "",
                          dateTo: "",
                        }))
                      }
                    >
                      Clear
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
              <FieldError message={dateRangeError} />
            </div>

            <div className="min-w-0 space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Status</label>
              <Select
                value={draftFilters.status}
                onValueChange={(value) =>
                  setDraftFilters((current) => ({ ...current, status: value }))
                }
                disabled={activeTab !== "appointments"}
              >
                <SelectTrigger aria-label="Appointment status">
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
            </div>

            <div className="flex gap-2 md:col-span-2 xl:col-span-1 xl:items-end">
              <Button
                type="button"
                className="flex-1 xl:flex-none"
                onClick={applyFilters}
                disabled={Boolean(dateRangeError)}
              >
                <SlidersHorizontal /> Apply filters
              </Button>
              <Button
                type="button"
                variant="outline"
                className="flex-1 xl:flex-none"
                onClick={resetFilters}
              >
                <RotateCcw /> Reset
              </Button>
            </div>
          </div>
          {activeTab !== "appointments" && (
            <p className="mt-3 text-xs text-muted-foreground">
              Status filtering is available for archived appointments.
            </p>
          )}
        </CardContent>
      </Card>

      <Tabs value={activeTab} onValueChange={setArchiveType} className="space-y-4">
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-2 bg-transparent p-0">
          {ARCHIVE_TABS.map((tab) => (
            <TabsTrigger
              key={tab.value}
              value={tab.value}
              className="min-h-9 bg-muted px-3 data-[state=active]:bg-background"
            >
              {tab.label} ({archiveCounts[tab.value]})
            </TabsTrigger>
          ))}
        </TabsList>

        <Card className="border-border/70 bg-card/60">
          <TabsContent value="appointments" className="mt-0">
            <CardContent className="overflow-x-auto p-0">
              <Table className="admin-data-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Customer</TableHead>
                    <TableHead>Schedule</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Estimate</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {appointmentRows.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell data-label="Reference" className="font-mono text-xs">
                        {a.reference_code}
                      </TableCell>
                      <TableCell data-label="Customer" className="text-sm">
                        {a.customer_name}
                        <span className="block text-xs text-muted-foreground">
                          {a.moto_brand} {a.moto_model} · {a.plate_number}
                        </span>
                      </TableCell>
                      <TableCell data-label="Schedule" className="text-xs">
                        {formatDateLong(a.appointment_date)}
                        <span className="block text-muted-foreground">
                          {formatTime(String(a.start_time).slice(0, 5))}
                        </span>
                      </TableCell>
                      <TableCell data-label="Status">
                        <Badge
                          variant="outline"
                          className={cn("text-[10px] uppercase", statusTone(a.status))}
                        >
                          {statusLabel(a.status)}
                        </Badge>
                      </TableCell>
                      <TableCell data-label="Estimate" className="text-sm">
                        {formatPHP(a.total_estimate)}
                      </TableCell>
                      <TableCell data-label="Actions" className="text-right">
                        <ArchiveRowActions
                          onRestore={() => restoreAppointment.mutate(a.id)}
                          onDelete={() => confirmDelete(a.id, "appointment")}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {appointmentRows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={6}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        {archived.isLoading ? "Loading archive..." : "Nothing archived yet."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </TabsContent>

          <TabsContent value="services" className="mt-0">
            <CardContent className="overflow-x-auto p-0">
              <Table className="admin-data-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Service</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Description</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {serviceRows.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell data-label="Service" className="text-sm font-medium">
                        {s.name}
                      </TableCell>
                      <TableCell data-label="Duration" className="text-sm">
                        {s.duration_minutes} mins
                      </TableCell>
                      <TableCell data-label="Price" className="text-sm text-primary">
                        {formatPHP(s.price)}
                      </TableCell>
                      <TableCell data-label="Description" className="text-xs text-muted-foreground">
                        {s.description ?? "-"}
                      </TableCell>
                      <TableCell data-label="Actions" className="text-right">
                        <ArchiveRowActions
                          onRestore={() => restoreService.mutate(s.id)}
                          onDelete={() => confirmDelete(s.id, "service")}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {serviceRows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        {archivedServices.isLoading
                          ? "Loading archive..."
                          : "No archived services."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </TabsContent>

          <TabsContent value="products" className="mt-0">
            <CardContent className="overflow-x-auto p-0">
              <Table className="admin-data-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Brand</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {productRows.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell data-label="Item">
                        <span className="block text-sm">{p.name}</span>
                        <span className="text-xs text-muted-foreground capitalize">
                          {p.category}
                        </span>
                      </TableCell>
                      <TableCell data-label="Brand" className="text-sm">
                        {p.brand ?? "-"}
                      </TableCell>
                      <TableCell data-label="Price" className="text-sm text-primary">
                        {formatPHP(p.price)}
                      </TableCell>
                      <TableCell data-label="Category" className="text-sm capitalize">
                        {p.category}
                      </TableCell>
                      <TableCell data-label="Actions" className="text-right">
                        <ArchiveRowActions
                          onRestore={() => restoreProduct.mutate(p.id)}
                          onDelete={() => confirmDelete(p.id, "product")}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {productRows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={5}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        {archivedProducts.isLoading
                          ? "Loading archive..."
                          : "No archived products."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </TabsContent>

          <TabsContent value="motorcycles" className="mt-0">
            <CardContent className="overflow-x-auto p-0">
              <Table className="admin-data-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead>Brand</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {motorcycleRows.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell data-label="Model" className="text-sm font-medium">
                        {p.model}
                      </TableCell>
                      <TableCell data-label="Brand" className="text-sm">
                        {p.brand ?? "-"}
                      </TableCell>
                      <TableCell data-label="Actions" className="text-right">
                        <ArchiveRowActions
                          onRestore={() => restoreMotorcycle.mutate(p.id)}
                          onDelete={() => confirmDelete(p.id, "motorcycle")}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {motorcycleRows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={3}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        {archivedMotorcycles.isLoading
                          ? "Loading archive..."
                          : "No archived motorcycles."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </TabsContent>

          <TabsContent value="crew" className="mt-0">
            <CardContent className="overflow-x-auto p-0">
              <Table className="admin-data-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {crewRows.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell data-label="Name" className="text-sm">
                        {c.name}
                      </TableCell>
                      <TableCell data-label="Role" className="text-sm">
                        {c.role}
                      </TableCell>
                      <TableCell data-label="Phone" className="text-sm">
                        {c.phone ?? "-"}
                      </TableCell>
                      <TableCell data-label="Actions" className="text-right">
                        <ArchiveRowActions
                          onRestore={() => restoreCrew.mutate(c.id)}
                          onDelete={() => confirmDelete(c.id, "crew")}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {crewRows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        {archivedCrew.isLoading
                          ? "Loading archive..."
                          : "No archived crew members."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </TabsContent>

          <TabsContent value="blocks" className="mt-0">
            <CardContent className="overflow-x-auto p-0">
              <Table className="admin-data-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Slot</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {blockRows.map((b) => (
                    <TableRow key={b.id}>
                      <TableCell data-label="Date" className="text-sm">
                        {formatDateLong(b.block_date)}
                      </TableCell>
                      <TableCell data-label="Slot" className="text-sm">
                        {b.start_time ? formatTime(String(b.start_time).slice(0, 5)) : "Whole day"}
                      </TableCell>
                      <TableCell data-label="Reason" className="text-sm text-muted-foreground">
                        {b.reason ?? "-"}
                      </TableCell>
                      <TableCell data-label="Actions" className="text-right">
                        <ArchiveRowActions
                          onRestore={() => restoreBlock.mutate(b.id)}
                          onDelete={() => confirmDelete(b.id, "block")}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {blockRows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        {archivedBlocks.isLoading
                          ? "Loading archive..."
                          : "No archived schedule blocks."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </TabsContent>

          <TabsContent value="blocked-numbers" className="mt-0">
            <CardContent className="overflow-x-auto p-0">
              <Table className="admin-data-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Phone</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Blocked on</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {blockedNumberRows.map((blockedNumber) => (
                    <TableRow key={blockedNumber.id}>
                      <TableCell data-label="Phone" className="font-mono text-sm">
                        {blockedNumber.phone}
                      </TableCell>
                      <TableCell data-label="Reason" className="text-sm text-muted-foreground">
                        {blockedNumber.reason ?? "-"}
                      </TableCell>
                      <TableCell data-label="Blocked on" className="text-sm">
                        {new Date(blockedNumber.created_at).toLocaleDateString("en-PH", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                        })}
                      </TableCell>
                      <TableCell data-label="Actions" className="text-right">
                        <ArchiveRowActions
                          onRestore={() => restoreBlockedNumber.mutate(blockedNumber.id)}
                          onDelete={() => confirmDelete(blockedNumber.id, "blockedNumber")}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                  {blockedNumberRows.length === 0 && (
                    <TableRow>
                      <TableCell
                        colSpan={4}
                        className="py-10 text-center text-sm text-muted-foreground"
                      >
                        {archivedBlockedNumbers.isLoading
                          ? "Loading archive..."
                          : "No archived blocked numbers."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </TabsContent>
          <PaginationControls
            page={page}
            pageSize={pageSize}
            total={activeArchive?.total ?? 0}
            onPageChange={setPage}
          />
        </Card>
      </Tabs>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Permanent Delete</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. The item will be permanently removed from the database.
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
    </div>
  );
}

function cleanSearchTerm(value: string) {
  return value
    .trim()
    .replace(/[,%_()]/g, " ")
    .replace(/\s+/g, " ");
}

function dateFromIso(value: string) {
  return new Date(`${value}T12:00:00`);
}

function formatDateRange(from: string, to: string) {
  if (!from) return "Select date range";

  const fromDate = dateFromIso(from);
  const fromLabel = format(fromDate, "MMM d, yyyy");
  if (!to) return `${fromLabel} – Select end date`;

  const toDate = dateFromIso(to);
  return fromDate.getFullYear() === toDate.getFullYear()
    ? `${format(fromDate, "MMM d")} – ${format(toDate, "MMM d, yyyy")}`
    : `${fromLabel} – ${format(toDate, "MMM d, yyyy")}`;
}

function startOfManilaDay(date: string) {
  return `${date}T00:00:00+08:00`;
}

function endOfDay(date: string) {
  return `${date}T23:59:59.999+08:00`;
}

function ArchiveRowActions({
  onRestore,
  onDelete,
}: {
  onRestore: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button size="sm" variant="outline" onClick={onRestore}>
        <RotateCcw /> Restore
      </Button>
      <Button size="sm" variant="destructive" onClick={onDelete}>
        <Trash2 /> Delete
      </Button>
    </div>
  );
}
