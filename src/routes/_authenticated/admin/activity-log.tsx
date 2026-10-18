import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { format } from "date-fns";
import { CalendarRange, ChevronDown, History, Printer, RefreshCw } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { useDeferredValue, useEffect, useMemo, useState } from "react";

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
import { PrintDocument, PrintTable } from "@/components/admin/print-document";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
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
  calendarRangeToIso,
  isoDateToCalendarDate,
  manilaMonthDateRange,
  manilaYearDateRange,
} from "@/lib/admin-date-range";
import { formatBusinessTimestamp } from "@/lib/export-branding";
import { recordAdminActivityEvent } from "@/lib/admin-activity";
import { usePrintWhenReady } from "@/lib/print-document";
import { addDays, manilaNow } from "@/lib/shop";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/activity-log")({
  component: ActivityLogPage,
});

const actionOptions = [
  "created",
  "updated",
  "status changed",
  "activated",
  "deactivated",
  "archived",
  "restored",
  "deleted",
  "exported",
  "printed",
  "signed in",
  "signed out",
];

const resourceOptions = [
  "Appointment Services",
  "Appointments",
  "Services",
  "Products",
  "Crew Members",
  "Schedule Blocks",
  "Blocked Numbers",
  "Time Slots",
  "Crew Schedules",
  "Crew Availability Exceptions",
  "Price History",
  "Notifications",
  "User Roles",
  "Activity Log",
  "Authentication",
  "Reports",
  "Settings",
  "Account Settings",
];

type ActivityLog = {
  id: string;
  actor_email: string | null;
  action: string;
  resource_type: string;
  target_label: string;
  summary: string;
  changed_fields: string[];
  activity_date: string;
  activity_time: string;
  created_at: string;
  record_id: string | null;
  ip_address: string | null;
};

type ActivityPrint = {
  records: ActivityLog[];
  generatedAt: string;
  coverage: string;
  scope: string;
};
type ActivityPeriod = "all" | "today" | "7d" | "month" | "year" | "custom";
type ActivityDateRange = { from: string; to: string };

function ActivityLogPage() {
  const pageSize = 10;
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [action, setAction] = useState("all");
  const [resource, setResource] = useState("all");
  const [activityPeriod, setActivityPeriod] = useState<ActivityPeriod>("all");
  const [activityCustomDateRange, setActivityCustomDateRange] = useState<DateRange>();
  const [page, setPage] = useState(0);
  const [printJob, setPrintJob] = useState<ActivityPrint | null>(null);
  const [isPrinting, setIsPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const deferredSearch = useDeferredValue(search);
  const filtersAreUpdating = search !== deferredSearch;
  const today = manilaNow().date;
  const activityDateRange = useMemo(
    () => activityRangeFromPeriod(activityPeriod, today, activityCustomDateRange),
    [activityCustomDateRange, activityPeriod, today],
  );
  const fromDate = activityDateRange?.from ?? "";
  const toDate = activityDateRange?.to ?? "";

  const hasFilters = Boolean(
    search.trim() || action !== "all" || resource !== "all" || activityPeriod !== "all",
  );

  const logs = useQuery({
    queryKey: [
      "admin-activity-logs",
      {
        search: deferredSearch,
        action,
        resource,
        fromDate,
        toDate,
        page,
      },
    ],
    queryFn: async () => {
      const { error: cleanupError } = await supabase.rpc("purge_expired_admin_activity_logs");
      if (cleanupError) throw cleanupError;
      let query = supabase
        .from("admin_activity_logs")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(page * pageSize, page * pageSize + pageSize - 1);

      if (fromDate) query = query.gte("activity_date", fromDate);
      if (toDate) query = query.lte("activity_date", toDate);

      if (action !== "all") query = query.eq("action", action);
      if (resource !== "all") query = query.eq("resource_type", resource);
      if (deferredSearch.trim()) {
        const term = cleanSearchTerm(deferredSearch);
        query = query.or(
          `summary.ilike.%${term}%,actor_email.ilike.%${term}%,target_label.ilike.%${term}%,ip_address.ilike.%${term}%`,
        );
      }

      const { data, error, count } = await query;
      if (error) throw error;
      return { rows: (data ?? []) as ActivityLog[], total: count ?? 0 };
    },
  });

  const rows = logs.data?.rows ?? [];
  const filterDescription = useMemo(() => {
    const total = logs.data?.total ?? 0;
    const noun = total === 1 ? "record" : "records";
    return hasFilters ? `${total} matching ${noun}` : `${total} ${noun} from the last 50 days`;
  }, [hasFilters, logs.data?.total]);

  useEffect(() => {
    setPage(0);
  }, [search, action, resource, activityPeriod, activityCustomDateRange]);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["admin-activity-logs"] });
  }

  function clearFilters() {
    setSearch("");
    setAction("all");
    setResource("all");
    setActivityPeriod("all");
    setActivityCustomDateRange(undefined);
    setPage(0);
  }

  async function fetchAllFilteredRows() {
    const { error: cleanupError } = await supabase.rpc("purge_expired_admin_activity_logs");
    if (cleanupError) throw cleanupError;

    const exportPageSize = 1_000;
    const allRows: ActivityLog[] = [];

    for (let offset = 0; ; offset += exportPageSize) {
      let query = supabase
        .from("admin_activity_logs")
        .select("*")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false });

      if (fromDate) query = query.gte("activity_date", fromDate);
      if (toDate) query = query.lte("activity_date", toDate);
      if (action !== "all") query = query.eq("action", action);
      if (resource !== "all") query = query.eq("resource_type", resource);
      if (deferredSearch.trim()) {
        const term = cleanSearchTerm(deferredSearch);
        query = query.or(
          `summary.ilike.%${term}%,actor_email.ilike.%${term}%,target_label.ilike.%${term}%,ip_address.ilike.%${term}%`,
        );
      }

      const { data, error } = await query.range(offset, offset + exportPageSize - 1);
      if (error) throw error;

      const batch = (data ?? []) as ActivityLog[];
      allRows.push(...batch);
      if (batch.length < exportPageSize) return allRows;
    }
  }

  usePrintWhenReady(printJob && `Admin Activity Log - ${printJob.coverage}`, () =>
    setPrintJob(null),
  );

  /** The dates the printout covers, as shown on its first page. */
  function printCoverage() {
    if (!fromDate || !toDate) return "All retained activity (last 50 days)";
    const label = activityPeriodLabel(activityPeriod, activityCustomDateRange);
    const dates =
      fromDate === toDate
        ? formatActivityDate(fromDate)
        : `${formatActivityDate(fromDate)} to ${formatActivityDate(toDate)}`;
    return activityPeriod === "custom" ? dates : `${label} (${dates})`;
  }

  /** The filters behind the printout, as shown on its first page. */
  function printScope(recordCount: number) {
    return [
      `${recordCount} ${recordCount === 1 ? "activity record" : "activity records"}`,
      `Action: ${action === "all" ? "All actions" : action}`,
      `Category: ${resource === "all" ? "All categories" : resource}`,
      deferredSearch.trim() ? `Search: ${deferredSearch.trim()}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  async function printActivityLog() {
    if (isPrinting) return;
    setIsPrinting(true);
    try {
      setPrintError(null);
      // The printout lists every matching record, not only the current page.
      const records = await fetchAllFilteredRows();
      setPrintJob({
        records,
        generatedAt: formatBusinessTimestamp(),
        coverage: printCoverage(),
        scope: printScope(records.length),
      });
      try {
        await recordAdminActivityEvent({
          action: "printed",
          resourceType: "Activity Log",
          targetLabel: "Admin Activity Log",
          summary: `Opened the print dialog for ${records.length} activity ${records.length === 1 ? "record" : "records"}.`,
          changedFields: ["date_range", "print_format"],
        });
        queryClient.invalidateQueries({ queryKey: ["admin-activity-logs"] });
      } catch (error) {
        // An audit-log failure must not stop a valid printout.
        console.error("Could not record activity log print:", error);
      }
    } catch (error) {
      console.error("Could not prepare the activity log for printing:", error);
      setPrintError("Could not prepare the activity log for printing. Please try again.");
    } finally {
      setIsPrinting(false);
    }
  }

  return (
    <AdminPage>
      <PageHeader
        title="Activity Log"
        description="Admin changes and sign-in events are retained for 50 days with record IDs and request IP addresses."
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={refresh} disabled={logs.isFetching}>
              <RefreshCw className={logs.isFetching ? "animate-spin" : ""} /> Refresh
            </Button>
            <Button
              variant="outline"
              className="font-display uppercase"
              onClick={() => void printActivityLog()}
              disabled={
                (logs.data?.total ?? 0) === 0 || logs.isFetching || filtersAreUpdating || isPrinting
              }
            >
              <Printer /> {isPrinting ? "Preparing print..." : "Print log"}
            </Button>
          </div>
        }
      />

      {printError && <InlineAlert>{printError}</InlineAlert>}

      <ListToolbar summary={logs.data && filterDescription}>
        <ToolbarSearch
          id="activity-search"
          value={search}
          onChange={setSearch}
          placeholder="Search activity, user, record, or IP"
          label="Search activity by summary, user, record, or IP address"
        />
        <ToolbarFilters>
          <Select value={action} onValueChange={setAction}>
            <SelectTrigger aria-label="Filter by action" className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {actionOptions.map((option) => (
                <SelectItem key={option} value={option} className="capitalize">
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={resource} onValueChange={setResource}>
            <SelectTrigger aria-label="Filter by category" className="w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {resourceOptions.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ActivityPeriodFilter
            period={activityPeriod}
            customDateRange={activityCustomDateRange}
            onPeriodChange={setActivityPeriod}
            onCustomDateRangeChange={setActivityCustomDateRange}
            className="col-span-2 w-full justify-between sm:w-auto"
          />
          {hasFilters && <ResetFiltersButton onClick={clearFilters} />}
        </ToolbarFilters>
      </ListToolbar>

      <ListCard
        footer={
          <PaginationControls
            page={page}
            pageSize={pageSize}
            total={logs.data?.total ?? 0}
            onPageChange={setPage}
          />
        }
      >
        <DataList
          label="Activity records"
          rows={rows}
          rowKey={(row) => row.id}
          loading={logs.isLoading}
          error={
            logs.isError
              ? { message: "Could not load the activity log.", onRetry: () => void logs.refetch() }
              : null
          }
          empty={
            <ListEmpty
              icon={History}
              title={
                hasFilters
                  ? "No activity matches your filters."
                  : "No activity in the last 50 days."
              }
              description={
                hasFilters
                  ? "Try a different search, action, category, or date."
                  : "Admin changes and sign-ins will appear here."
              }
              action={hasFilters ? <ResetFiltersButton onClick={clearFilters} /> : undefined}
            />
          }
          columns={[
            {
              key: "when",
              header: "When",
              className: "w-36",
              cell: (row) => (
                <span className="text-sm">
                  {formatActivityDate(row.activity_date)}
                  <span className="block text-xs text-muted-foreground">
                    {formatActivityTime(row.activity_time)}
                  </span>
                </span>
              ),
            },
            {
              key: "activity",
              header: "Activity",
              card: "title",
              cell: (row) => (
                <>
                  <p className="text-sm font-medium">{row.summary}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {row.target_label}
                    <span className="block">by {row.actor_email ?? "Unknown admin"}</span>
                  </p>
                </>
              ),
            },
            {
              key: "category",
              header: "Category",
              card: "badge",
              className: "w-40",
              cell: (row) => (
                <Badge variant="outline" className="max-w-full text-left whitespace-normal">
                  {row.resource_type}
                </Badge>
              ),
            },
            {
              key: "fields",
              header: "Changed fields",
              card: "wide",
              xlOnly: true,
              className: "w-56",
              cell: (row) =>
                row.changed_fields.length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {row.changed_fields.map((field) => (
                      <Badge key={field} variant="secondary" className="font-normal">
                        {field.replace(/_/g, " ")}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">None</span>
                ),
            },
            {
              key: "record",
              header: "Record ID",
              table: false,
              cell: (row) => (
                <span className="font-mono text-xs break-all">{row.record_id ?? "None"}</span>
              ),
            },
            {
              key: "ip",
              header: "IP address",
              table: false,
              cell: (row) => (
                <span className="font-mono text-xs">{row.ip_address ?? "Unavailable"}</span>
              ),
            },
            {
              key: "source",
              header: "Record & IP",
              card: false,
              xlOnly: true,
              className: "w-52",
              cell: (row) => (
                <span className="font-mono text-xs break-all">
                  {row.record_id ?? "No record ID"}
                  <span className="block text-muted-foreground">
                    {row.ip_address ?? "IP unavailable"}
                  </span>
                </span>
              ),
            },
          ]}
        />
      </ListCard>

      <PrintActivityLog job={printJob} />
    </AdminPage>
  );
}

function ActivityPeriodFilter({
  period,
  customDateRange,
  onPeriodChange,
  onCustomDateRangeChange,
  className,
}: {
  period: ActivityPeriod;
  customDateRange: DateRange | undefined;
  onPeriodChange: (period: ActivityPeriod) => void;
  onCustomDateRangeChange: (range: DateRange | undefined) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [isPickingCustomRange, setIsPickingCustomRange] = useState(false);
  const [draftCustomDateRange, setDraftCustomDateRange] = useState<DateRange>();

  const selectPeriod = (nextPeriod: Exclude<ActivityPeriod, "custom">) => {
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
        <Button type="button" variant="outline" className={cn("gap-1.5", className)}>
          <CalendarRange className="size-3.5" aria-hidden="true" />
          {activityPeriodLabel(period, customDateRange)}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        {isPickingCustomRange ? (
          <div>
            <div className="px-2 pb-2">
              <p className="text-sm font-medium">Custom activity date range</p>
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
              <ActivityDateRangeValue label="Start date" value={draftCustomDateRange?.from} />
              <ActivityDateRangeValue label="End date" value={draftCustomDateRange?.to} />
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
              Activity date
            </p>
            <ActivityPeriodOption
              active={period === "all"}
              label="All activity dates"
              onClick={() => selectPeriod("all")}
            />
            <ActivityPeriodOption
              active={period === "today"}
              label="Today"
              onClick={() => selectPeriod("today")}
            />
            <ActivityPeriodOption
              active={period === "7d"}
              label="Last 7 days"
              onClick={() => selectPeriod("7d")}
            />
            <ActivityPeriodOption
              active={period === "month"}
              label="This month"
              onClick={() => selectPeriod("month")}
            />
            <ActivityPeriodOption
              active={period === "year"}
              label="This year"
              onClick={() => selectPeriod("year")}
            />
            <ActivityPeriodOption
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

function ActivityPeriodOption({
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

function ActivityDateRangeValue({ label, value }: { label: string; value: Date | undefined }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-2 py-1.5">
      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-0.5 truncate font-medium text-foreground">
        {value ? format(value, "MMM d, yyyy") : "Not selected"}
      </p>
    </div>
  );
}

function activityPeriodLabel(period: ActivityPeriod, customRange?: DateRange) {
  if (period === "all") return "All activity dates";
  if (period === "today") return "Today";
  if (period === "7d") return "Last 7 days";
  if (period === "month") return "This month";
  if (period === "year") return "This year";
  if (!customRange?.from || !customRange.to) return "Custom date range";
  return `${format(customRange.from, "MMM d")} – ${format(customRange.to, "MMM d, yyyy")}`;
}

function activityRangeFromPeriod(
  period: ActivityPeriod,
  today: string,
  customRange?: DateRange,
): ActivityDateRange | undefined {
  if (period === "all") return undefined;
  if (period === "today") return { from: today, to: today };
  if (period === "7d") return { from: addDays(today, -6), to: today };

  if (period === "month") {
    return manilaMonthDateRange(today);
  }
  if (period === "year") {
    return manilaYearDateRange(today);
  }
  if (customRange?.from && customRange.to) {
    return calendarRangeToIso(customRange);
  }
  return undefined;
}

function cleanSearchTerm(value: string) {
  return value
    .trim()
    .replace(/[,%_()]/g, " ")
    .replace(/\s+/g, " ");
}

function formatActivityDate(date: string) {
  return isoDateToCalendarDate(date).toLocaleDateString("en-PH", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatActivityTime(time: string) {
  const [hours = "0", minutes = "0"] = time.split(":");
  const hour = Number(hours);
  return `${hour % 12 || 12}:${minutes} ${hour >= 12 ? "PM" : "AM"}`;
}

function printRows(rows: ActivityLog[]) {
  return rows.map((row) => [
    formatActivityDate(row.activity_date),
    formatActivityTime(row.activity_time),
    row.actor_email ?? "Unknown admin",
    row.action,
    row.resource_type,
    row.target_label,
    row.record_id ?? "—",
    row.ip_address ?? "Unavailable",
    row.changed_fields.map((field) => field.replace(/_/g, " ")).join(", ") || "—",
  ]);
}

/** The printable activity log: every matching record in one table. */
function PrintActivityLog({ job }: { job: ActivityPrint | null }) {
  if (!job) return null;
  return (
    <PrintDocument
      info={{
        title: "Admin Activity Log",
        subtitle: "Activity record",
        generatedAt: job.generatedAt,
        coverage: job.coverage,
        scope: job.scope,
      }}
    >
      <PrintTable
        title="Activity records"
        headers={[
          "Date",
          "Time",
          "User",
          "Action",
          "Category",
          "Record",
          "Record ID",
          "IP address",
          "Changed fields",
        ]}
        columnWidths={["8%", "6%", "14%", "8%", "10%", "14%", "16%", "9%", "15%"]}
        rows={printRows(job.records)}
        emptyMessage="No activity matches these filters."
        lastColumn="text"
      />
    </PrintDocument>
  );
}
