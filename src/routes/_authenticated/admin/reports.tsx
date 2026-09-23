import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { format } from "date-fns";
import {
  BarChart3,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  CircleDollarSign,
  Download,
  FileText,
  Filter,
  ListFilter,
  RotateCcw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { useEffect, useMemo, useRef, useState } from "react";

import exportLogoUrl from "@/assets/export-logo.png";
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
import { FieldError } from "@/components/ui/field-error";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
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
import { recordAdminActivityEvent } from "@/lib/admin-activity";
import {
  formatBusinessTimestamp,
  getShopLogoDataUrl,
  SHOP_EXPORT_NAME,
  SHOP_OWNER_NAME,
} from "@/lib/export-branding";
import {
  SHOP,
  addDays,
  formatDateLong,
  formatPHP,
  manilaNow,
  statusLabel,
  statusTone,
} from "@/lib/shop";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/reports")({
  component: ReportsPage,
});

const periodOptions = [
  { value: "today", label: "Today" },
  { value: "this_week", label: "This week" },
  { value: "this_month", label: "This month" },
  { value: "this_year", label: "This year" },
  { value: "custom", label: "Custom dates" },
] as const;

const statusOptions = [
  "pending",
  "confirmed",
  "in_progress",
  "completed",
  "rescheduled",
  "cancelled",
  "rejected",
  "no_show",
];

type ReportKind = "bookings" | "services";
type PeriodPreset = (typeof periodOptions)[number]["value"];
type ExportType = "pdf" | "docx";
type ReportFilters = {
  periodPreset: PeriodPreset;
  from: string;
  to: string;
  category: string;
  serviceName: string;
  status: string;
};

type CatalogService = { id: string; name: string; category: string };
type BookingRow = {
  id: string;
  reference_code: string;
  customer_name: string;
  appointment_date: string;
  service: string;
  status: string;
  total_estimate: number | string;
};
type ServiceRow = {
  appointment_id: string;
  service_id: string | null;
  service_name: string;
  price: number | string;
  reference_code: string;
  customer_name: string;
  appointment_date: string;
  status: string;
  category: string;
};
type ReportMetrics = {
  total_bookings: number;
  completed_bookings?: number;
  completed_rows?: number;
  completed_value: number | string;
  status_counts: Record<string, number>;
};
type ReportPage = { rows: Array<BookingRow | ServiceRow>; total: number; metrics: ReportMetrics };
type ExportCardTone = "primary" | "success" | "accent" | "chart";
type ExportSummaryCard = {
  label: string;
  value: string;
  detail: string;
  tone: ExportCardTone;
};
type ExportData = {
  headers: string[];
  rows: string[][];
  cards: ExportSummaryCard[];
  totalAmount: number;
};
function ReportsPage() {
  const pageSize = 10;
  const today = manilaNow().date;
  const initialFilters = getInitialFilters(today);
  const [draftFilters, setDraftFilters] = useState<ReportFilters>(initialFilters);
  const [filters, setFilters] = useState<ReportFilters>(initialFilters);
  const [page, setPage] = useState(0);
  const [pendingExport, setPendingExport] = useState<ExportType | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const reportKind: ReportKind = "bookings";
  const { from, to, status, category, serviceName } = filters;
  const customDateError =
    draftFilters.periodPreset === "custom" && (!draftFilters.from || !draftFilters.to)
      ? "Select both a start and end date."
      : draftFilters.from > draftFilters.to
        ? "The end date must be on or after the start date."
        : undefined;

  const catalog = useQuery({
    queryKey: ["report-service-catalog"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("services")
        .select("id,name,category")
        .order("category")
        .order("name");
      if (error) throw error;
      return (data ?? []) as CatalogService[];
    },
  });

  const data = useQuery({
    queryKey: ["reports", { reportKind, from, to, status, category, serviceName, page }],
    queryFn: () =>
      getReportPage({
        reportKind,
        from,
        to,
        status,
        category,
        serviceName,
        limit: pageSize,
        offset: page * pageSize,
      }),
  });

  const categories = useMemo(
    () =>
      Array.from(new Set((catalog.data ?? []).map((item) => item.category).filter(Boolean))).sort(),
    [catalog.data],
  );
  const serviceOptions = useMemo(
    () =>
      (catalog.data ?? [])
        .filter(
          (item) => draftFilters.category === "all" || item.category === draftFilters.category,
        )
        .sort((first, second) => first.name.localeCompare(second.name)),
    [catalog.data, draftFilters.category],
  );
  const metrics = data.data?.metrics;
  const byStatus = Object.entries(metrics?.status_counts ?? {}).sort(([first], [second]) =>
    first.localeCompare(second),
  );
  const preview = makeExportData(reportKind, data.data?.rows ?? [], metrics);
  const reportTitle =
    reportKind === "bookings"
      ? "Booking Report"
      : `${serviceName !== "all" ? serviceName : category !== "all" ? category : "All Services"} Activity Report`;
  const appliedFilters = [
    { label: "Reporting period", value: formatDateRange(from, to) },
    { label: "Service category", value: category === "all" ? "All categories" : category },
    { label: "Specific service", value: serviceName === "all" ? "All services" : serviceName },
    { label: "Booking status", value: status === "all" ? "All statuses" : statusLabel(status) },
  ];
  const reportScope = appliedFilters
    .slice(1)
    .map((filter) => `${filter.label}: ${filter.value}`)
    .join(" · ");

  function updatePeriod(value: PeriodPreset) {
    setDraftFilters((current) => {
      if (value === "custom") return { ...current, periodPreset: value };
      const range = periodRange(value, today);
      return {
        ...current,
        periodPreset: value,
        ...range,
        // Month and year presets start as overall booking reports and must
        // not inherit a previous status selection. Admins can subsequently
        // select a status, category, or service to narrow the report scope.
        ...(value === "this_month" || value === "this_year" ? { status: "all" } : {}),
      };
    });
  }

  function applyFilters() {
    if (customDateError) return;
    setFilters({ ...draftFilters });
    setPage(0);
  }

  function resetFilters() {
    const nextFilters = getInitialFilters(today);
    setDraftFilters(nextFilters);
    setFilters(nextFilters);
    setPage(0);
  }

  async function confirmExport() {
    if (!pendingExport) return;
    try {
      setExportError(null);
      const allRows = await getAllReportRows({
        reportKind,
        from,
        to,
        status,
        category,
        serviceName,
      });
      const exportData = makeExportData(reportKind, allRows.rows, allRows.metrics);
      if (pendingExport === "pdf")
        await exportPdf(exportData, reportKind, reportTitle, reportScope, from, to);
      if (pendingExport === "docx")
        await exportDocx(exportData, reportKind, reportTitle, reportScope, from, to);
      await recordAdminActivityEvent({
        action: "exported",
        resourceType: "Reports",
        targetLabel: reportTitle,
        summary: `Exported ${allRows.total} ${reportKind === "services" ? "service entries" : "bookings"} as ${pendingExport.toUpperCase()}.`,
        changedFields: ["report_type", "date_range", "export_format"],
      });
    } catch {
      setExportError("Could not create this report export. Please try again.");
    } finally {
      setPendingExport(null);
    }
  }

  const rowLabel = "bookings";

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
            <BarChart3 className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="font-display text-2xl tracking-wide uppercase md:text-3xl">Reports</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              View booking volume and service activity for a selected period.
            </p>
          </div>
        </div>
        <div className="w-full sm:w-auto">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                disabled={!data.data?.total}
                className="w-full uppercase sm:w-auto"
              >
                <Download /> Export selected report
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setPendingExport("pdf")}>
                <FileText className="mr-2 h-4 w-4" /> Export PDF table
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setPendingExport("docx")}>
                <FileText className="mr-2 h-4 w-4" /> Export DOCX document
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      {exportError && (
        <p role="alert" className="mb-5 text-sm text-destructive">
          {exportError}
        </p>
      )}

      <Card className="mb-5 border-border/70 bg-card/60">
        <CardContent className="p-4 sm:p-5">
          <div className="mb-4 flex items-center gap-2">
            <Filter className="size-4 text-primary" aria-hidden="true" />
            <h2 className="font-display text-base tracking-wide uppercase">Filters</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.25fr)_auto] lg:items-end">
            <FilterSelect
              label="Service category"
              value={draftFilters.category}
              onValueChange={(value) => {
                setDraftFilters((current) => ({
                  ...current,
                  category: value,
                  serviceName: "all",
                }));
              }}
              options={[
                { value: "all", label: "All categories" },
                ...categories.map((value) => ({ value, label: value })),
              ]}
            />
            <div className="min-w-0 space-y-1.5">
              <Label>Service</Label>
              <Select
                value={draftFilters.serviceName}
                onValueChange={(value) =>
                  setDraftFilters((current) => ({ ...current, serviceName: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All services</SelectItem>
                  {serviceOptions.map((item) => (
                    <SelectItem key={item.id} value={item.name}>
                      {item.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <FilterSelect
              label="Booking status"
              value={draftFilters.status}
              onValueChange={(value) =>
                setDraftFilters((current) => ({ ...current, status: value }))
              }
              options={[
                { value: "all", label: "All statuses" },
                ...statusOptions.map((value) => ({ value, label: statusLabel(value) })),
              ]}
            />
            <div className="min-w-0 space-y-1.5">
              <Label>Period</Label>
              <PeriodPicker
                value={draftFilters.periodPreset}
                from={draftFilters.from}
                to={draftFilters.to}
                error={customDateError}
                onValueChange={updatePeriod}
                onRangeChange={(range) =>
                  setDraftFilters((current) => ({
                    ...current,
                    periodPreset: "custom",
                    ...range,
                  }))
                }
              />
            </div>
            <div className="flex gap-2 md:col-span-2 lg:col-span-1 lg:self-end">
              <Button
                type="button"
                className="flex-1 whitespace-nowrap lg:flex-none"
                onClick={applyFilters}
                disabled={Boolean(customDateError)}
              >
                <Filter /> Apply filters
              </Button>
              <Button
                type="button"
                variant="outline"
                className="flex-1 whitespace-nowrap lg:flex-none"
                onClick={resetFilters}
              >
                <RotateCcw /> Reset
              </Button>
            </div>
          </div>
          <div className="mt-4 border-t border-border pt-3" aria-live="polite">
            <p className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
              Applied report scope
            </p>
            <dl className="mt-2 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {appliedFilters.map((filter) => (
                <div
                  key={filter.label}
                  className="min-w-0 rounded-md border border-border/70 bg-muted/30 px-3 py-2"
                >
                  <dt className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    {filter.label}
                  </dt>
                  <dd className="mt-0.5 truncate text-sm font-medium text-foreground">
                    {filter.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </CardContent>
      </Card>

      <section aria-labelledby="report-summary-heading" className="mb-6">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <BarChart3 className="size-4 text-primary" aria-hidden="true" />
              <h2
                id="report-summary-heading"
                className="font-display text-base tracking-wide uppercase"
              >
                Report summary
              </h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{reportScope}</p>
          </div>
          <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-right">
            <p className="text-[10px] font-semibold tracking-wider text-primary uppercase">
              Reporting period
            </p>
            <p className="font-display text-sm tracking-wide uppercase">
              {formatDateRange(from, to)}
            </p>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Total Bookings"
            value={String(metrics?.total_bookings ?? 0)}
            detail="All bookings in selected period"
            icon={CalendarDays}
            iconClassName="bg-chart-4/15 text-chart-4"
          />
          <Stat
            label="Completed Jobs"
            value={String(metrics?.completed_bookings ?? 0)}
            detail={'Bookings with status "Completed"'}
            icon={CheckCircle2}
            iconClassName="bg-emerald-500/15 text-emerald-400"
          />
          <Stat
            label="Revenue (Completed Jobs)"
            value={formatPHP(metrics?.completed_value ?? 0)}
            detail="Total amount from completed jobs"
            icon={CircleDollarSign}
            iconClassName="bg-accent/15 text-accent"
          />
          <Stat
            label="Status Groups"
            value={String(byStatus.length)}
            detail="Different booking statuses in scope"
            icon={BarChart3}
            iconClassName="bg-chart-4/15 text-chart-4"
          />
        </div>
      </section>

      <Card className="border-border/70 bg-card/60">
        <CardContent className="overflow-x-auto p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
            <div className="flex items-center gap-2">
              <ListFilter className="size-4 text-primary" aria-hidden="true" />
              <div>
                <h2 className="font-display text-base tracking-wide uppercase">
                  Bookings for Selected Period
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">{reportScope}</p>
              </div>
            </div>
            <span className="text-xs text-muted-foreground">
              Page {data.data?.total ? page + 1 : 0} of{" "}
              {Math.max(1, Math.ceil((data.data?.total ?? 0) / pageSize))}
            </span>
          </div>
          <Table className="admin-data-table">
            <TableHeader>
              <TableRow>
                {preview.headers.map((header) => (
                  <TableHead key={header}>{header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {preview.rows.map((row, index) => (
                <TableRow key={`${row[0]}-${index}`}>
                  {row.map((cell, cellIndex) => (
                    <TableCell
                      key={`${cellIndex}-${cell}`}
                      data-label={preview.headers[cellIndex]}
                      className="text-sm"
                    >
                      {preview.headers[cellIndex] === "Status" ? (
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] uppercase",
                            statusTone(data.data?.rows[index]?.status ?? ""),
                          )}
                        >
                          {cell}
                        </Badge>
                      ) : (
                        cell
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {!data.isLoading && preview.rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={preview.headers.length}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No {rowLabel} match this report selection.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {data.isLoading && (
            <p className="p-8 text-center text-sm text-muted-foreground">Loading report…</p>
          )}
          {data.isError && (
            <p className="p-8 text-center text-sm text-destructive">
              Could not load this report. Please try again.
            </p>
          )}
          <PaginationControls
            page={page}
            pageSize={pageSize}
            total={data.data?.total ?? 0}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>

      <AlertDialog
        open={pendingExport !== null}
        onOpenChange={(open) => !open && setPendingExport(null)}
      >
        <AlertDialogContent className="max-w-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm {pendingExport?.toUpperCase()} export</AlertDialogTitle>
            <AlertDialogDescription>
              You are about to export the selected {reportTitle.toLowerCase()} as a{" "}
              <strong className="font-medium text-foreground">
                {pendingExport?.toUpperCase()}
              </strong>{" "}
              file with all {data.data?.total ?? 0} {rowLabel}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ExportFormatPreview
            format={pendingExport}
            reportKind={reportKind}
            title={reportTitle}
            period={formatDateRange(from, to)}
            scope={reportScope}
            data={preview}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmExport}>
              Export {pendingExport?.toUpperCase()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ExportFormatPreview({
  format,
  reportKind,
  title,
  period,
  scope,
  data,
}: {
  format: ExportType | null;
  reportKind: ReportKind;
  title: string;
  period: string;
  scope: string;
  data: ExportData;
}) {
  const isDocx = format === "docx";
  const formatLabel = isDocx ? "Word document (.docx)" : "PDF document (.pdf)";
  const previewRows = data.rows.slice(0, 3);

  return (
    <div className="rounded-lg border border-border bg-muted/20 p-3 sm:p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-md bg-primary/10 text-primary">
            <FileText className="size-4" aria-hidden="true" />
          </span>
          <div>
            <p className="text-sm font-medium">{formatLabel}</p>
            <p className="text-xs text-muted-foreground">Export preview</p>
          </div>
        </div>
        <span className="rounded border border-border bg-background px-2 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {format}
        </span>
      </div>

      <div className="rounded-md border border-border bg-muted/60 p-3 sm:p-4">
        <div className="mx-auto aspect-[297/210] w-full max-w-2xl overflow-hidden bg-background px-3 py-2 font-sans text-foreground shadow-md sm:px-4 sm:py-3">
          <div className="flex items-center justify-between gap-3 rounded-md bg-foreground px-3 py-2 text-background">
            <div className="flex min-w-0 items-center gap-2">
              <img src={exportLogoUrl} alt="" className="h-10 w-[4.5rem] shrink-0 object-contain" />
              <div className="min-w-0">
                <p className="truncate text-[8px] font-bold tracking-wide">{SHOP_EXPORT_NAME}</p>
                <p className="truncate text-[5px] opacity-80">{SHOP.tagline}</p>
              </div>
            </div>
            <div className="shrink-0 text-right">
              <p className="text-[7px] font-bold uppercase">{title}</p>
              <p className="mt-0.5 text-[5px] opacity-80">Generated {formatBusinessTimestamp()}</p>
            </div>
          </div>
          <div className="mt-2 rounded border border-border bg-muted/40 px-2 py-1">
            <p className="text-[5px] font-bold tracking-wider text-primary uppercase">
              Report period
            </p>
            <p className="text-[7px] font-semibold">{period}</p>
            <p className="text-[4px] leading-tight text-muted-foreground">Filters: {scope}</p>
          </div>
          <p className="mt-2 flex items-center gap-2 text-[6px] font-bold tracking-wide uppercase">
            <span className="h-px flex-1 bg-primary/60" />
            <span>Report summary</span>
            <span className="h-px flex-1 bg-primary/60" />
          </p>
          <div className="mt-1 grid grid-cols-4 gap-1">
            {data.cards.map((card) => (
              <div
                key={card.label}
                className="min-w-0 rounded border border-border bg-card px-1.5 py-1"
              >
                <p className="truncate text-[4px] font-bold tracking-wide text-muted-foreground uppercase">
                  {card.label}
                </p>
                <p className="truncate text-[8px] font-bold text-primary">{card.value}</p>
                <p className="truncate text-[4px] text-muted-foreground">{card.detail}</p>
              </div>
            ))}
          </div>
          <p className="mt-2 flex items-center gap-2 text-[6px] font-bold tracking-wide uppercase">
            <span className="h-px flex-1 bg-primary/60" />
            <span>
              {reportKind === "services" ? "Service entries" : "Bookings for selected period"}
            </span>
            <span className="h-px flex-1 bg-primary/60" />
          </p>
          <ExportDocumentTable data={data} rows={previewRows} variant={isDocx ? "docx" : "pdf"} />
          <div className="mt-5 flex justify-between gap-4 text-[4px] text-muted-foreground">
            <span>Prepared By: ____________________</span>
            <span className="text-right">
              Approved By: <strong className="text-foreground">{SHOP_OWNER_NAME}</strong> · Shop
              Owner
            </span>
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        This preview mirrors the actual {isDocx ? "Word document" : "PDF"} layout. The exported file
        includes the complete table.
      </p>
    </div>
  );
}

function ExportDocumentTable({
  data,
  rows,
  variant,
}: {
  data: ExportData;
  rows: string[][];
  variant: "pdf" | "docx";
}) {
  return (
    <table className="mt-2 w-full table-fixed border-collapse text-[4px] leading-tight">
      <thead className="bg-foreground text-background">
        <tr>
          {data.headers.map((header) => (
            <th
              key={header}
              className="truncate border border-border px-0.5 py-0.5 text-left font-bold"
            >
              {header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${row.join("-")}-${index}`}>
            {row.map((cell, cellIndex) => (
              <td
                key={`${cell}-${cellIndex}`}
                className="truncate border border-border px-0.5 py-0.5"
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FilterSelect({
  label,
  value,
  onValueChange,
  options,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function PeriodPicker({
  value,
  from,
  to,
  error,
  onValueChange,
  onRangeChange,
}: {
  value: PeriodPreset;
  from: string;
  to: string;
  error?: string | undefined;
  onValueChange: (value: PeriodPreset) => void;
  onRangeChange: (range: { from: string; to: string }) => void;
}) {
  const [customOpen, setCustomOpen] = useState(false);
  const customOpenTimer = useRef<number | null>(null);
  const selectedRange = from
    ? { from: dateFromIso(from), to: to ? dateFromIso(to) : undefined }
    : undefined;
  const [draftRange, setDraftRange] = useState<DateRange | undefined>(selectedRange);
  const [calendarMonth, setCalendarMonth] = useState<Date>(() => selectedRange?.from ?? new Date());

  function clearPendingCustomOpen() {
    if (customOpenTimer.current === null) return;
    window.clearTimeout(customOpenTimer.current);
    customOpenTimer.current = null;
  }

  useEffect(() => clearPendingCustomOpen, []);

  function scheduleCustomOpen() {
    clearPendingCustomOpen();
    setDraftRange(selectedRange);
    setCalendarMonth(selectedRange?.from ?? new Date());
    // Wait until Radix Select has finished restoring focus to its trigger.
    // Opening sooner makes the Popover see that focus restoration as an
    // outside interaction and dismiss itself immediately.
    customOpenTimer.current = window.setTimeout(() => {
      customOpenTimer.current = null;
      setCustomOpen(true);
    }, 100);
  }

  function handlePeriodValueChange(nextValue: string) {
    const nextPeriod = nextValue as PeriodPreset;
    if (nextPeriod !== "custom") {
      clearPendingCustomOpen();
      onValueChange(nextPeriod);
      setCustomOpen(false);
      return;
    }

    onValueChange("custom");
    scheduleCustomOpen();
  }

  return (
    <div className="space-y-1.5">
      <Popover
        open={customOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) clearPendingCustomOpen();
          setCustomOpen(nextOpen);
        }}
      >
        <PopoverAnchor asChild>
          <div>
            <Select value={value} onValueChange={handlePeriodValueChange}>
              <SelectTrigger aria-label="Select report period" aria-invalid={Boolean(error)}>
                <CalendarRange className="mr-2 size-4 shrink-0 text-muted-foreground" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {periodOptions.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    onPointerDown={option.value === "custom" ? scheduleCustomOpen : undefined}
                    onKeyDown={(event) => {
                      if (
                        option.value === "custom" &&
                        (event.key === "Enter" || event.key === " ")
                      ) {
                        scheduleCustomOpen();
                      }
                    }}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </PopoverAnchor>
        <PopoverContent align="start" className="w-auto max-w-[calc(100vw-2rem)] p-2">
          <div className="px-1 pb-2">
            <p className="text-sm font-medium">Custom date range</p>
            <p className="text-xs text-muted-foreground">Select a start date and an end date.</p>
          </div>
          <Calendar
            mode="range"
            selected={draftRange}
            month={calendarMonth}
            onMonthChange={setCalendarMonth}
            onSelect={setDraftRange}
            classNames={{
              nav: "inset-x-auto left-1/2 w-48 -translate-x-1/2 justify-between",
            }}
          />
          <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
            <DateRangeValue label="Start date" value={draftRange?.from} />
            <DateRangeValue label="End date" value={draftRange?.to} />
          </div>
          <div className="mt-3 flex justify-end gap-2 border-t border-border pt-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setDraftRange(selectedRange);
                setCustomOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!draftRange?.from || !draftRange.to}
              onClick={() => {
                if (!draftRange?.from || !draftRange.to) return;
                const draftFrom = format(draftRange.from, "yyyy-MM-dd");
                const draftTo = format(draftRange.to, "yyyy-MM-dd");
                onRangeChange(
                  draftFrom <= draftTo
                    ? { from: draftFrom, to: draftTo }
                    : { from: draftTo, to: draftFrom },
                );
                setCustomOpen(false);
              }}
            >
              Apply
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <FieldError message={error} />
    </div>
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

async function getReportPage(input: {
  reportKind: ReportKind;
  from: string;
  to: string;
  status: string;
  category: string;
  serviceName: string;
  limit: number;
  offset: number;
}) {
  const { data, error } = await supabase.rpc("get_admin_report_page", {
    p_report_kind: input.reportKind,
    p_from: input.from,
    p_to: input.to,
    p_status: input.status === "all" ? null : input.status,
    p_category: input.category === "all" ? null : input.category,
    p_service_name: input.serviceName === "all" ? null : input.serviceName,
    p_limit: input.limit,
    p_offset: input.offset,
  });
  if (error) throw error;
  return data as unknown as ReportPage;
}

async function getAllReportRows(
  input: Omit<Parameters<typeof getReportPage>[0], "limit" | "offset">,
) {
  const limit = 250;
  let offset = 0;
  let first: ReportPage | null = null;
  let rows: Array<BookingRow | ServiceRow> = [];
  do {
    const current = await getReportPage({ ...input, limit, offset });
    first ??= current;
    rows = rows.concat(current.rows);
    offset += current.rows.length;
  } while (first && offset < first.total);
  return { rows, total: first?.total ?? 0, metrics: first?.metrics };
}

function makeExportData(
  reportKind: ReportKind,
  rows: Array<BookingRow | ServiceRow>,
  metrics?: ReportMetrics,
): ExportData {
  if (reportKind === "services") {
    const serviceRows = rows as ServiceRow[];
    return {
      headers: ["Reference", "Customer", "Date", "Status", "Service", "Category", "Value"],
      rows: serviceRows.map((row) => [
        row.reference_code,
        row.customer_name,
        formatDateLong(row.appointment_date),
        statusLabel(row.status),
        row.service_name,
        row.category,
        `PHP ${Number(row.price).toFixed(2)}`,
      ]),
      cards: [
        {
          label: "Service entries",
          value: String(serviceRows.length),
          detail: "Entries in selected period",
          tone: "primary",
        },
        {
          label: "Bookings served",
          value: String(metrics?.total_bookings ?? 0),
          detail: "Bookings represented",
          tone: "chart",
        },
        {
          label: "Completed entries",
          value: String(metrics?.completed_rows ?? 0),
          detail: "Jobs with status Completed",
          tone: "success",
        },
        {
          label: "Completed value",
          value: formatPHP(metrics?.completed_value ?? 0),
          detail: "Value from completed jobs",
          tone: "accent",
        },
      ],
      totalAmount: Number(metrics?.completed_value ?? 0),
    };
  }
  const bookingRows = rows as BookingRow[];
  return {
    headers: ["Reference", "Customer", "Date", "Service", "Status", "Amount"],
    rows: bookingRows.map((row) => [
      row.reference_code,
      row.customer_name,
      formatDateLong(row.appointment_date),
      row.service || "—",
      statusLabel(row.status),
      `PHP ${Number(row.total_estimate).toFixed(2)}`,
    ]),
    cards: [
      {
        label: "Total bookings",
        value: String(metrics?.total_bookings ?? 0),
        detail: "All bookings in selected period",
        tone: "primary",
      },
      {
        label: "Completed jobs",
        value: String(metrics?.completed_bookings ?? 0),
        detail: 'Jobs with status "Completed"',
        tone: "success",
      },
      {
        label: "Revenue (completed jobs)",
        value: formatPHP(metrics?.completed_value ?? 0),
        detail: "Total amount from completed jobs",
        tone: "accent",
      },
      {
        label: "Status groups",
        value: String(Object.keys(metrics?.status_counts ?? {}).length),
        detail: "Different booking status groups",
        tone: "chart",
      },
    ],
    totalAmount: Number(metrics?.completed_value ?? 0),
  };
}

function getInitialFilters(today: string): ReportFilters {
  const range = periodRange("this_month", today);
  return {
    periodPreset: "this_month",
    ...range,
    category: "all",
    serviceName: "all",
    status: "all",
  };
}

function dateFromIso(value: string) {
  return new Date(`${value}T12:00:00`);
}

function formatDateRange(from: string, to: string) {
  if (!from) return "Select custom dates";

  const fromDate = dateFromIso(from);
  const fromLabel = format(fromDate, "MMM d, yyyy");
  if (!to) return `${fromLabel} to Select end date`;

  const toDate = dateFromIso(to);
  return fromDate.getFullYear() === toDate.getFullYear()
    ? `${format(fromDate, "MMM d")} to ${format(toDate, "MMM d, yyyy")}`
    : `${fromLabel} to ${format(toDate, "MMM d, yyyy")}`;
}

function periodRange(preset: Exclude<PeriodPreset, "custom">, today: string) {
  if (preset === "today") return { from: today, to: today };
  if (preset === "this_week") {
    const day = new Date(`${today}T00:00:00`).getDay();
    const from = addDays(today, -((day + 6) % 7));
    return { from, to: addDays(from, 6) };
  }
  if (preset === "this_year") {
    const year = today.slice(0, 4);
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }

  const [year = 1970, month = 1] = today.slice(0, 7).split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${today.slice(0, 8)}01`,
    to: `${today.slice(0, 8)}${String(lastDay).padStart(2, "0")}`,
  };
}

async function exportPdf(
  data: ExportData,
  reportKind: ReportKind,
  title: string,
  scope: string,
  from: string,
  to: string,
) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import("jspdf"),
    import("jspdf-autotable"),
  ]);
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const logo = await getShopLogoDataUrl();
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;
  const colors = {
    ink: [55, 43, 31] as [number, number, number],
    paper: [255, 253, 247] as [number, number, number],
    muted: [246, 241, 231] as [number, number, number],
    border: [222, 211, 190] as [number, number, number],
    primary: [185, 132, 26] as [number, number, number],
    accent: [201, 88, 26] as [number, number, number],
    success: [55, 133, 91] as [number, number, number],
    chart: [75, 94, 155] as [number, number, number],
    white: [255, 255, 255] as [number, number, number],
  };

  doc.setFillColor(...colors.paper);
  doc.rect(0, 0, pageWidth, pageHeight, "F");

  const drawHeader = (continuation = false) => {
    doc.setFillColor(...colors.ink);
    doc.roundedRect(
      margin,
      continuation ? 7 : 10,
      pageWidth - margin * 2,
      continuation ? 13 : 30,
      3,
      3,
      "F",
    );
    if (continuation) {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(7);
      doc.setTextColor(...colors.white);
      doc.text(`${SHOP_EXPORT_NAME}  ·  ${title.toUpperCase()}`, margin + 5, 15);
      doc.setDrawColor(...colors.primary);
      doc.setLineWidth(0.6);
      doc.line(margin, 21, pageWidth - margin, 21);
      return;
    }
    // Keep the source logo's 360:202 aspect ratio while giving it a stronger
    // presence in the header.
    doc.addImage(logo, "PNG", margin + 4, 13, 42, 23.55);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...colors.white);
    doc.setFontSize(15);
    doc.text(SHOP_EXPORT_NAME, margin + 51, 21);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.text(SHOP.tagline, margin + 51, 27);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.text(title.toUpperCase(), pageWidth - margin - 5, 20, { align: "right" });
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7.5);
    doc.text(`Generated: ${formatBusinessTimestamp()}`, pageWidth - margin - 5, 27, {
      align: "right",
    });
  };

  drawHeader();
  const periodY = 47;
  doc.setFillColor(...colors.muted);
  doc.setDrawColor(...colors.border);
  doc.roundedRect(margin, periodY, pageWidth - margin * 2, 21, 2, 2, "FD");
  doc.setDrawColor(...colors.primary);
  doc.setLineWidth(1.1);
  doc.line(margin + 6, periodY + 4, margin + 6, periodY + 11);
  doc.line(margin + 3, periodY + 6, margin + 9, periodY + 6);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(...colors.ink);
  doc.setFontSize(7);
  doc.text("REPORT PERIOD", margin + 14, periodY + 6);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10.5);
  doc.text(`${formatDateRange(from, to)}`, margin + 14, periodY + 11.5);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(5.6);
  const scopeLines = doc.splitTextToSize(`Filters: ${scope}`, pageWidth - margin * 2 - 28);
  doc.text(scopeLines, margin + 14, periodY + 16);

  const drawSectionHeading = (label: string, y: number) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(...colors.ink);
    doc.text(label.toUpperCase(), margin + 10, y);
    doc.setDrawColor(...colors.primary);
    doc.setLineWidth(0.45);
    doc.line(margin + 52, y - 1, pageWidth - margin, y - 1);
  };

  drawSectionHeading("Report summary", 75);
  const cardGap = 4;
  const cardY = 79;
  const cardH = 25;
  const cardW = (pageWidth - margin * 2 - cardGap * 3) / 4;
  const cardColors = {
    primary: { fill: [255, 246, 220] as [number, number, number], line: colors.primary },
    success: { fill: [235, 247, 238] as [number, number, number], line: colors.success },
    accent: { fill: [255, 239, 226] as [number, number, number], line: colors.accent },
    chart: { fill: [237, 240, 252] as [number, number, number], line: colors.chart },
  };
  data.cards.forEach((card, index) => {
    const x = margin + index * (cardW + cardGap);
    const palette = cardColors[card.tone];
    doc.setFillColor(...palette.fill);
    doc.setDrawColor(...colors.border);
    doc.roundedRect(x, cardY, cardW, cardH, 2, 2, "FD");
    doc.setFillColor(...palette.line);
    doc.circle(x + 9, cardY + 10, 5.5, "F");
    doc.setTextColor(...colors.white);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(card.tone === "accent" ? 6 : 9);
    doc.text(
      card.tone === "success"
        ? "✓"
        : card.tone === "accent"
          ? "P"
          : card.tone === "chart"
            ? "#"
            : "B",
      x + 9,
      cardY + 12,
      { align: "center" },
    );
    doc.setTextColor(...colors.ink);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.5);
    doc.text(card.label.toUpperCase(), x + 18, cardY + 7);
    doc.setFontSize(card.value.length > 16 ? 10 : 14);
    doc.text(card.value, x + 18, cardY + 15.5);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(5.8);
    doc.setTextColor(...colors.ink);
    doc.text(doc.splitTextToSize(card.detail, cardW - 20), x + 18, cardY + 21);
  });

  drawSectionHeading(
    reportKind === "services" ? "Service entries" : "Bookings for selected period",
    113,
  );
  autoTable(doc, {
    startY: 117,
    head: [data.headers],
    body: data.rows,
    theme: "grid",
    margin: { left: margin, right: margin, top: 27, bottom: 34 },
    styles: {
      font: "helvetica",
      fontSize: 7.2,
      cellPadding: 2.1,
      textColor: colors.ink,
      lineColor: colors.border,
      lineWidth: 0.2,
      valign: "middle",
    },
    headStyles: {
      fillColor: colors.ink,
      textColor: colors.white,
      fontStyle: "bold",
      fontSize: 7.2,
      cellPadding: 2.7,
    },
    alternateRowStyles: { fillColor: colors.paper },
    columnStyles:
      reportKind === "services"
        ? {
            0: { cellWidth: 29 },
            1: { cellWidth: 38 },
            2: { cellWidth: 40 },
            3: { cellWidth: 27 },
            4: { cellWidth: 42 },
            5: { cellWidth: 34 },
            6: { cellWidth: 35, halign: "right" },
          }
        : {
            0: { cellWidth: 35 },
            1: { cellWidth: 43 },
            2: { cellWidth: 51 },
            3: { cellWidth: 52 },
            4: { cellWidth: 29, halign: "center" },
            5: { cellWidth: 39, halign: "right" },
          },
    didParseCell: (hook) => {
      const statusIndex = data.headers.indexOf("Status");
      if (hook.section === "body" && hook.column.index === statusIndex) {
        hook.cell.styles.fontStyle = "bold";
        hook.cell.styles.halign = "center";
        const status = String(hook.cell.raw ?? "").toLowerCase();
        if (status.includes("completed")) hook.cell.styles.textColor = colors.success;
        else if (
          status.includes("cancelled") ||
          status.includes("rejected") ||
          status.includes("no show")
        )
          hook.cell.styles.textColor = [177, 56, 43];
        else if (status.includes("confirmed")) hook.cell.styles.textColor = colors.chart;
        else if (status.includes("pending") || status.includes("rescheduled"))
          hook.cell.styles.textColor = colors.accent;
      }
    },
    didDrawPage: (hook) => {
      if (hook.pageNumber > 1) drawHeader(true);
    },
  });
  const finalY =
    (doc as typeof doc & { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 112;
  doc.setPage(doc.getNumberOfPages());
  const signatureTop = pageHeight - 24;
  let totalY = finalY + 9;
  // Keep the total and both signatures together on the final page. When the
  // final table is too long, use a dedicated sign-off page rather than
  // crowding either element below the table.
  if (totalY + 13 > signatureTop - 10) {
    doc.addPage();
    drawHeader(true);
    totalY = 31;
  }
  doc.setFillColor(...colors.muted);
  doc.setDrawColor(...colors.border);
  doc.roundedRect(margin, totalY - 5, pageWidth - margin * 2, 11, 1.5, 1.5, "FD");
  doc.setTextColor(...colors.ink);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.text("TOTAL AMOUNT", pageWidth - margin - 61, totalY + 2);
  doc.setFontSize(11);
  doc.text(formatPHP(data.totalAmount), pageWidth - margin - 4, totalY + 2, { align: "right" });

  doc.setFont("helvetica", "normal");
  doc.setFontSize(7);
  doc.text("Prepared By", margin + 2, signatureTop);
  doc.setDrawColor(...colors.border);
  doc.line(margin + 2, signatureTop + 14, margin + 72, signatureTop + 14);
  doc.text("Approved By", pageWidth - margin - 72, signatureTop);
  doc.setFont("helvetica", "bold");
  doc.text(SHOP_OWNER_NAME, pageWidth - margin - 36, signatureTop + 6, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.text("Shop Owner", pageWidth - margin - 36, signatureTop + 10, { align: "center" });
  doc.line(pageWidth - margin - 72, signatureTop + 14, pageWidth - margin, signatureTop + 14);
  doc.save(`fake-rider-${fileName(reportKind)}-${from}-to-${to}.pdf`);
}

async function exportDocx(
  data: ExportData,
  reportKind: ReportKind,
  title: string,
  scope: string,
  from: string,
  to: string,
) {
  const {
    AlignmentType,
    BorderStyle,
    Document,
    ImageRun,
    Packer,
    PageOrientation,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    TextRun,
    WidthType,
  } = await import("docx");
  const logoData = dataUrlToUint8Array(await getShopLogoDataUrl());
  const border = { style: BorderStyle.SINGLE, color: "DED3BE", size: 5 };
  const tableBorders = {
    top: border,
    bottom: border,
    left: border,
    right: border,
    insideHorizontal: border,
    insideVertical: border,
  };
  const text = (value: string, options: Record<string, unknown> = {}) =>
    new TextRun({ text: value, font: "Arial", size: 17, ...options });
  const headerRow = new TableRow({
    tableHeader: true,
    children: data.headers.map(
      (header) =>
        new TableCell({
          shading: { fill: "372B1F" },
          margins: { top: 90, bottom: 90, left: 90, right: 90 },
          children: [
            new Paragraph({ children: [text(header, { bold: true, color: "FFFFFF", size: 16 })] }),
          ],
        }),
    ),
  });
  const rows = data.rows.map(
    (row, rowIndex) =>
      new TableRow({
        children: row.map(
          (cell, cellIndex) =>
            new TableCell({
              shading: rowIndex % 2 === 1 ? { fill: "FFFDF7" } : { fill: "FFFFFF" },
              margins: { top: 75, bottom: 75, left: 90, right: 90 },
              children: [
                new Paragraph({
                  alignment:
                    cellIndex === row.length - 1 ? AlignmentType.RIGHT : AlignmentType.LEFT,
                  children: [
                    text(cell, { color: "372B1F", bold: data.headers[cellIndex] === "Status" }),
                  ],
                }),
              ],
            }),
        ),
      }),
  );
  const summaryCards = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [3900, 3900, 3900, 3900],
    borders: tableBorders,
    rows: [
      new TableRow({
        children: data.cards.map(
          (card) =>
            new TableCell({
              shading: {
                fill:
                  card.tone === "primary"
                    ? "FFF6DC"
                    : card.tone === "success"
                      ? "EBF7EE"
                      : card.tone === "accent"
                        ? "FFEFE2"
                        : "EDF0FC",
              },
              margins: { top: 120, bottom: 120, left: 110, right: 110 },
              children: [
                new Paragraph({
                  children: [
                    text(card.label.toUpperCase(), { bold: true, size: 14, color: "6A5C4B" }),
                  ],
                }),
                new Paragraph({
                  children: [
                    text(card.value, {
                      bold: true,
                      size: card.value.length > 16 ? 22 : 28,
                      color: "B9841A",
                    }),
                  ],
                }),
                new Paragraph({ children: [text(card.detail, { size: 13, color: "6A5C4B" })] }),
              ],
            }),
        ),
      }),
    ],
  });
  const periodTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: tableBorders,
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: "F6F1E7" },
            margins: { top: 100, bottom: 100, left: 130, right: 130 },
            children: [
              new Paragraph({
                children: [text("REPORT PERIOD", { bold: true, size: 14, color: "B9841A" })],
              }),
              new Paragraph({
                children: [
                  text(formatDateRange(from, to), { bold: true, size: 22, color: "372B1F" }),
                ],
              }),
              new Paragraph({
                children: [text(`Filters: ${scope}`, { size: 13, color: "6A5C4B" })],
              }),
            ],
          }),
        ],
      }),
    ],
  });
  const sectionHeading = (label: string) =>
    new Paragraph({
      spacing: { before: 180, after: 80 },
      border: { bottom: { style: BorderStyle.SINGLE, color: "B9841A", size: 7, space: 1 } },
      children: [text(label.toUpperCase(), { bold: true, size: 17, color: "372B1F" })],
    });
  const totalTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [12500, 3200],
    borders: tableBorders,
    rows: [
      new TableRow({
        children: [
          new TableCell({
            shading: { fill: "F6F1E7" },
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [text("TOTAL AMOUNT", { bold: true, size: 16, color: "372B1F" })],
              }),
            ],
          }),
          new TableCell({
            shading: { fill: "F6F1E7" },
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [
                  text(formatPHP(data.totalAmount), { bold: true, size: 19, color: "B9841A" }),
                ],
              }),
            ],
          }),
        ],
      }),
    ],
  });
  const signatureTable = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.NONE, color: "FFFFFF", size: 0 },
      bottom: { style: BorderStyle.NONE, color: "FFFFFF", size: 0 },
      left: { style: BorderStyle.NONE, color: "FFFFFF", size: 0 },
      right: { style: BorderStyle.NONE, color: "FFFFFF", size: 0 },
      insideVertical: { style: BorderStyle.NONE, color: "FFFFFF", size: 0 },
    },
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: [
              new Paragraph({ children: [text("Prepared By", { size: 14, color: "6A5C4B" })] }),
              new Paragraph({
                border: {
                  bottom: { style: BorderStyle.SINGLE, color: "DED3BE", size: 5, space: 1 },
                },
                children: [text(" ", { size: 12 })],
              }),
            ],
          }),
          new TableCell({
            children: [
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [text("Approved By", { size: 14, color: "6A5C4B" })],
              }),
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [text(SHOP_OWNER_NAME, { bold: true, size: 15, color: "372B1F" })],
              }),
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [text("Shop Owner", { size: 13, color: "6A5C4B" })],
              }),
              new Paragraph({
                border: {
                  bottom: { style: BorderStyle.SINGLE, color: "DED3BE", size: 5, space: 1 },
                },
                children: [text(" ", { size: 12 })],
              }),
            ],
          }),
        ],
      }),
    ],
  });
  const document = new Document({
    sections: [
      {
        properties: {
          page: {
            size: { width: 16838, height: 11906, orientation: PageOrientation.LANDSCAPE },
            margin: { top: 567, right: 567, bottom: 567, left: 567 },
          },
        },
        children: [
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            columnWidths: [10300, 5400],
            borders: {
              top: { style: BorderStyle.SINGLE, color: "372B1F", size: 12 },
              bottom: { style: BorderStyle.SINGLE, color: "372B1F", size: 12 },
              left: { style: BorderStyle.SINGLE, color: "372B1F", size: 12 },
              right: { style: BorderStyle.SINGLE, color: "372B1F", size: 12 },
              insideVertical: { style: BorderStyle.SINGLE, color: "372B1F", size: 2 },
            },
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    shading: { fill: "372B1F" },
                    margins: { top: 100, bottom: 100, left: 130, right: 130 },
                    children: [
                      new Paragraph({
                        children: [
                          new ImageRun({
                            data: logoData,
                            type: "png",
                            // 360:202 source ratio; larger without distortion.
                            transformation: { width: 105, height: 59 },
                          }),
                        ],
                      }),
                      new Paragraph({
                        children: [
                          text(SHOP_EXPORT_NAME, { bold: true, size: 22, color: "FFFFFF" }),
                        ],
                      }),
                      new Paragraph({
                        children: [text(SHOP.tagline, { size: 13, color: "F6F1E7" })],
                      }),
                    ],
                  }),
                  new TableCell({
                    shading: { fill: "372B1F" },
                    margins: { top: 100, bottom: 100, left: 130, right: 130 },
                    children: [
                      new Paragraph({
                        alignment: AlignmentType.RIGHT,
                        children: [
                          text(title.toUpperCase(), { bold: true, size: 24, color: "FFFFFF" }),
                        ],
                      }),
                      new Paragraph({
                        alignment: AlignmentType.RIGHT,
                        children: [
                          text(`Generated: ${formatBusinessTimestamp()}`, {
                            size: 14,
                            color: "F6F1E7",
                          }),
                        ],
                      }),
                    ],
                  }),
                ],
              }),
            ],
          }),
          periodTable,
          sectionHeading("Report summary"),
          summaryCards,
          sectionHeading(
            reportKind === "services" ? "Service entries" : "Bookings for selected period",
          ),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: tableBorders,
            rows: [headerRow, ...rows],
          }),
          new Paragraph({
            spacing: { before: 360, after: 180 },
            children: [text(" ", { size: 10 })],
          }),
          totalTable,
          new Paragraph({
            spacing: { before: 260, after: 120 },
            children: [text(" ", { size: 10 })],
          }),
          signatureTable,
        ],
      },
    ],
  });
  const file = await Packer.toBlob(document);
  downloadBlob(
    file,
    `fake-rider-${fileName(reportKind)}-${from}-to-${to}.docx`,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  );
}

function dataUrlToUint8Array(dataUrl: string) {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function downloadBlob(contents: BlobPart, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
function fileName(reportKind: ReportKind) {
  return reportKind === "services" ? "service-activity-report" : "booking-report";
}

function Stat({
  label,
  value,
  detail,
  icon: Icon,
  iconClassName,
}: {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  iconClassName?: string;
}) {
  return (
    <Card className="border-border/70 bg-card/70 shadow-sm">
      <CardContent className="p-3.5 sm:p-4">
        <div className="flex items-center gap-2.5">
          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary",
              iconClassName,
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
              {label}
            </p>
            <p className="mt-0.5 font-display text-2xl leading-none text-primary">{value}</p>
          </div>
        </div>
        <p className="mt-2 truncate text-[11px] text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}
