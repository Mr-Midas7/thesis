import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { format } from "date-fns";
import {
  BarChart3,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  CircleDollarSign,
  Filter,
  ListFilter,
  Printer,
  RotateCcw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { useEffect, useMemo, useState } from "react";

import exportLogoUrl from "@/assets/export-logo.png";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field-error";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
import {
  calendarDateToIso,
  calendarRangeToIso,
  isoDateToCalendarDate,
  manilaMonthDateRange,
  manilaWeekDateRange,
  manilaYearDateRange,
} from "@/lib/admin-date-range";
import { recordAdminActivityEvent } from "@/lib/admin-activity";
import { formatBusinessTimestamp, SHOP_EXPORT_NAME, SHOP_OWNER_NAME } from "@/lib/export-branding";
import { SHOP, formatDateLong, formatPHP, manilaNow, statusLabel, statusTone } from "@/lib/shop";
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

type ReportKind = "bookings" | "services" | "financial";
type PeriodPreset = (typeof periodOptions)[number]["value"];
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
  products?: string;
  status: string;
  total_estimate: number | string;
  service_subtotal?: number | string;
  product_subtotal?: number | string;
  total_amount?: number | string;
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
  total_value?: number | string;
  service_total?: number | string;
  product_total?: number | string;
  status_counts: Record<string, number>;
};
type ReportPage = { rows: Array<BookingRow | ServiceRow>; total: number; metrics: ReportMetrics };
type FinancialTransactionRow = {
  id: string;
  reference_code: string;
  transaction_date: string;
  services: string;
  products: string;
  service_amount: number | string;
  product_amount: number | string;
  total_amount: number | string;
};
type FinancialMetrics = {
  total_revenue: number | string;
  service_revenue: number | string;
  product_revenue: number | string;
  completed_transactions: number;
  total_completed_services: number;
  total_products_sold: number;
  average_transaction_amount: number | string;
};
type ServicePerformanceRow = {
  service_name: string;
  completed_count: number;
  revenue: number | string;
};
type ProductSalesRow = {
  product_name: string;
  quantity_sold: number;
  unit_price: number | string;
  total_sales: number | string;
};
type RevenuePeriodRow = {
  period: string;
  completed_transactions: number;
  service_revenue: number | string;
  product_revenue: number | string;
  total_revenue: number | string;
};
type FinancialReportPage = {
  rows: FinancialTransactionRow[];
  total: number;
  metrics: FinancialMetrics;
  service_performance: ServicePerformanceRow[];
  product_sales: ProductSalesRow[];
  daily_revenue: RevenuePeriodRow[];
  monthly_revenue: RevenuePeriodRow[];
};
type ReportSummaryCard = {
  label: string;
  value: string;
  detail: string;
  tone: "primary" | "chart" | "success" | "accent";
};
type ReportData = {
  headers: string[];
  rows: string[][];
  cards: ReportSummaryCard[];
  totalAmount: number;
};
type PrintPayload = {
  data: ReportData;
  generatedAt: string;
  period: string;
  reportKind: ReportKind;
  scope: string;
  title: string;
  financial?: {
    servicePerformance: ServicePerformanceRow[];
    productSales: ProductSalesRow[];
    revenueTitle: string;
    revenueRows: RevenuePeriodRow[];
  };
};
function ReportsPage() {
  const pageSize = 10;
  const today = manilaNow().date;
  const initialFilters = getInitialFilters(today);
  const [draftFilters, setDraftFilters] = useState<ReportFilters>(initialFilters);
  const [filters, setFilters] = useState<ReportFilters>(initialFilters);
  const [page, setPage] = useState(0);
  const [isPrinting, setIsPrinting] = useState(false);
  const [printError, setPrintError] = useState<string | null>(null);
  const [printPayload, setPrintPayload] = useState<PrintPayload | null>(null);
  const [revenuePeriod, setRevenuePeriod] = useState<"daily" | "monthly">("daily");
  const [serviceListDialog, setServiceListDialog] = useState<{
    referenceCode: string;
    services: string[];
  } | null>(null);
  const reportKind: ReportKind = "financial";
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
  const financialReport = data.data as FinancialReportPage | undefined;
  const metrics = financialReport?.metrics;
  const reportData = makeReportData(reportKind, financialReport?.rows ?? [], metrics);
  const reportTitle = "Financial Report (Summary)";
  const revenueRows =
    revenuePeriod === "daily"
      ? (financialReport?.daily_revenue ?? [])
      : (financialReport?.monthly_revenue ?? []);
  const appliedFilters = [
    { label: "Completed on", value: formatDateRange(from, to) },
    { label: "Service category", value: category === "all" ? "All categories" : category },
    { label: "Specific service", value: serviceName === "all" ? "All services" : serviceName },
    { label: "Transactions", value: "Completed only" },
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

  useEffect(() => {
    if (!printPayload) return;
    const timer = window.setTimeout(() => {
      window.print();
      setPrintPayload(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [printPayload]);

  async function printReport() {
    if (isPrinting) return;
    setIsPrinting(true);
    try {
      setPrintError(null);
      const allRows = await getAllReportRows({
        reportKind,
        from,
        to,
        status,
        category,
        serviceName,
      });
      // Print totals and completed metrics are derived from the complete
      // filtered result set, not the currently visible paginated page.
      const completeReportData = makeReportData(reportKind, allRows.rows, allRows.metrics, {
        hasCompleteRows: true,
      });
      setPrintPayload({
        data: completeReportData,
        generatedAt: formatBusinessTimestamp(),
        period: formatDateRange(from, to),
        reportKind,
        scope: reportScope,
        title: reportTitle,
        ...(allRows.financial
          ? {
              financial: {
                servicePerformance: allRows.financial.service_performance,
                productSales: allRows.financial.product_sales,
                revenueTitle: revenuePeriod === "daily" ? "Daily revenue" : "Monthly revenue",
                revenueRows:
                  revenuePeriod === "daily"
                    ? allRows.financial.daily_revenue
                    : allRows.financial.monthly_revenue,
              },
            }
          : {}),
      });
      try {
        await recordAdminActivityEvent({
          action: "printed",
          resourceType: "Reports",
          targetLabel: reportTitle,
          summary: `Opened the print dialog for ${allRows.total} completed transactions.`,
          changedFields: ["report_type", "date_range", "print_format"],
        });
      } catch (error) {
        // An audit-log failure must not prevent a valid report from printing.
        console.error("Could not record report print activity:", error);
      }
    } catch (error) {
      console.error("Could not prepare report for printing:", error);
      setPrintError("Could not prepare this report for printing. Please try again.");
    } finally {
      setIsPrinting(false);
    }
  }

  const rowLabel = "completed transactions";

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
            <BarChart3 className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="font-display text-2xl tracking-wide uppercase md:text-3xl">
              Financial Report (Summary)
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Track completed revenue, service performance, and product sales for the selected
              period.
            </p>
          </div>
        </div>
        <div className="w-full sm:w-auto">
          <Button
            type="button"
            variant="outline"
            disabled={!data.data?.total || isPrinting}
            className="w-full uppercase sm:w-auto"
            onClick={() => void printReport()}
          >
            <Printer /> {isPrinting ? "Preparing print..." : "Print report"}
          </Button>
        </div>
      </header>
      {printError && (
        <p role="alert" className="mb-5 text-sm text-destructive">
          {printError}
        </p>
      )}

      <Card className="mb-5 border-border/70 bg-card/60">
        <CardContent className="p-4 sm:p-5">
          <div className="mb-4 flex items-center gap-2">
            <Filter className="size-4 text-primary" aria-hidden="true" />
            <h2 className="font-display text-base tracking-wide uppercase">Filters</h2>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.25fr)_auto] lg:items-end">
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
          <p className="mt-4 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-muted-foreground">
            Only completed appointments are included in revenue. Pending, rejected, cancelled, and
            rescheduled appointments are excluded from all financial totals.
          </p>
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
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <Stat
            label="Total Revenue"
            value={formatPHP(metrics?.total_revenue ?? 0)}
            detail="Completed service and product revenue"
            icon={CircleDollarSign}
            iconClassName="bg-emerald-500/15 text-emerald-400"
          />
          <Stat
            label="Service Revenue"
            value={formatPHP(metrics?.service_revenue ?? 0)}
            detail="From completed services"
            icon={CircleDollarSign}
            iconClassName="bg-primary/15 text-primary"
          />
          <Stat
            label="Product Revenue"
            value={formatPHP(metrics?.product_revenue ?? 0)}
            detail="From products sold during service"
            icon={CircleDollarSign}
            iconClassName="bg-accent/15 text-accent"
          />
          <Stat
            label="Completed Transactions"
            value={String(metrics?.completed_transactions ?? 0)}
            detail="Revenue-recognized appointments"
            icon={CheckCircle2}
            iconClassName="bg-chart-4/15 text-chart-4"
          />
          <Stat
            label="Total Completed Services"
            value={String(metrics?.total_completed_services ?? 0)}
            detail="Service entries performed"
            icon={CalendarDays}
            iconClassName="bg-primary/15 text-primary"
          />
          <Stat
            label="Total Products Sold"
            value={String(metrics?.total_products_sold ?? 0)}
            detail="Units recorded during completed service"
            icon={CircleDollarSign}
            iconClassName="bg-accent/15 text-accent"
          />
          <Stat
            label="Average Transaction"
            value={formatPHP(metrics?.average_transaction_amount ?? 0)}
            detail="Average amount per completed transaction"
            icon={CheckCircle2}
            iconClassName="bg-emerald-500/15 text-emerald-400"
          />
        </div>
      </section>

      <div className="mb-6 grid gap-4 xl:grid-cols-2">
        <FinancialTableCard
          title="Service Performance"
          description="Completed services and revenue recognized from their saved service prices."
          headers={["Service", "Completed", "Revenue"]}
          rows={(financialReport?.service_performance ?? []).map((row) => [
            row.service_name,
            String(row.completed_count),
            formatPHP(row.revenue),
          ])}
          emptyMessage="No completed services match this report selection."
          totalLabel="Total service revenue"
          totalValue={formatPHP(metrics?.service_revenue ?? 0)}
        />
        <FinancialTableCard
          title="Product Sales"
          description="Products recorded during completed appointments, grouped by their saved selling price."
          headers={["Product", "Qty Sold", "Unit Price", "Total Sales"]}
          rows={(financialReport?.product_sales ?? []).map((row) => [
            row.product_name,
            String(row.quantity_sold),
            formatPHP(row.unit_price),
            formatPHP(row.total_sales),
          ])}
          emptyMessage="No products were sold in completed transactions for this period."
          totalLabel="Total product revenue"
          totalValue={formatPHP(metrics?.product_revenue ?? 0)}
        />
      </div>

      <Card className="mb-6 border-border/70 bg-card/60">
        <CardContent className="overflow-x-auto p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
            <div>
              <h2 className="font-display text-base tracking-wide uppercase">Revenue over time</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Completed transaction revenue by {revenuePeriod} period.
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant={revenuePeriod === "daily" ? "default" : "outline"}
                onClick={() => setRevenuePeriod("daily")}
              >
                Daily
              </Button>
              <Button
                type="button"
                size="sm"
                variant={revenuePeriod === "monthly" ? "default" : "outline"}
                onClick={() => setRevenuePeriod("monthly")}
              >
                Monthly
              </Button>
            </div>
          </div>
          <Table className="admin-data-table">
            <TableHeader>
              <TableRow>
                <TableHead>{revenuePeriod === "daily" ? "Date" : "Month"}</TableHead>
                <TableHead className="text-right">Transactions</TableHead>
                <TableHead className="text-right">Service Revenue</TableHead>
                <TableHead className="text-right">Product Revenue</TableHead>
                <TableHead className="text-right">Total Revenue</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {revenueRows.map((row) => (
                <TableRow key={row.period}>
                  <TableCell className="text-sm">
                    {formatRevenuePeriod(row.period, revenuePeriod)}
                  </TableCell>
                  <TableCell className="text-right text-sm">{row.completed_transactions}</TableCell>
                  <TableCell className="text-right text-sm">
                    {formatPHP(row.service_revenue)}
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {formatPHP(row.product_revenue)}
                  </TableCell>
                  <TableCell className="text-right text-sm font-medium text-primary">
                    {formatPHP(row.total_revenue)}
                  </TableCell>
                </TableRow>
              ))}
              {!data.isLoading && revenueRows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                    No completed revenue is available for this period.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="border-border/70 bg-card/60">
        <CardContent className="overflow-x-auto p-0">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
            <div className="flex items-center gap-2">
              <ListFilter className="size-4 text-primary" aria-hidden="true" />
              <div>
                <h2 className="font-display text-base tracking-wide uppercase">
                  Completed Transactions
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
                {reportData.headers.map((header) => (
                  <TableHead key={header}>{header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {reportData.rows.map((row, index) => (
                <TableRow key={`${row[0]}-${index}`}>
                  {row.map((cell, cellIndex) => (
                    <TableCell
                      key={`${cellIndex}-${cell}`}
                      data-label={reportData.headers[cellIndex]}
                      className="text-sm"
                    >
                      {reportData.headers[cellIndex] === "Status" ? (
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] uppercase",
                            statusTone(
                              data.data?.rows[index] && "status" in data.data.rows[index]
                                ? data.data.rows[index].status
                                : "",
                            ),
                          )}
                        >
                          {cell}
                        </Badge>
                      ) : reportData.headers[cellIndex] === "Services" ? (
                        <ReportServicesCell
                          value={cell}
                          referenceCode={row[0] ?? "this booking"}
                          onSeeMore={(services) =>
                            setServiceListDialog({ referenceCode: row[0] ?? "", services })
                          }
                        />
                      ) : (
                        cell
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {!data.isLoading && reportData.rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={reportData.headers.length}
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

      <Dialog
        open={serviceListDialog !== null}
        onOpenChange={(open) => !open && setServiceListDialog(null)}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display uppercase">Services</DialogTitle>
            <DialogDescription>
              Complete service list for booking {serviceListDialog?.referenceCode}.
            </DialogDescription>
          </DialogHeader>
          <ul className="max-h-[50vh] space-y-2 overflow-y-auto pr-1">
            {serviceListDialog?.services.map((service, index) => (
              <li
                key={`${service}-${index}`}
                className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-sm"
              >
                {service}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setServiceListDialog(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PrintReport payload={printPayload} />
    </div>
  );
}

function ReportServicesCell({
  value,
  referenceCode,
  onSeeMore,
}: {
  value: string;
  referenceCode: string;
  onSeeMore: (services: string[]) => void;
}) {
  const services = splitServiceNames(value);
  const needsSeeMore = services.length > 1 || value.length > 42;

  if (!needsSeeMore) return <span className="break-words">{value}</span>;

  const summary =
    services.length > 1 ? `${services[0]} +${services.length - 1} more` : (services[0] ?? value);

  return (
    <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 text-left">
      <span className="min-w-0 truncate">{summary}</span>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto shrink-0 px-0 py-0 text-xs leading-5"
        aria-label={`See all services for booking ${referenceCode}`}
        onClick={() => onSeeMore(services)}
      >
        See More
      </Button>
    </div>
  );
}

function FinancialTableCard({
  title,
  description,
  headers,
  rows,
  emptyMessage,
  totalLabel,
  totalValue,
}: {
  title: string;
  description: string;
  headers: string[];
  rows: string[][];
  emptyMessage: string;
  totalLabel: string;
  totalValue: string;
}) {
  return (
    <Card className="border-border/70 bg-card/60">
      <CardContent className="overflow-x-auto p-0">
        <div className="border-b border-border px-4 py-4 sm:px-5">
          <h2 className="font-display text-base tracking-wide uppercase">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        <Table className="admin-data-table">
          <TableHeader>
            <TableRow>
              {headers.map((header) => (
                <TableHead key={header} className={header === headers[0] ? "" : "text-right"}>
                  {header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={`${row[0]}-${index}`}>
                {row.map((cell, cellIndex) => (
                  <TableCell
                    key={`${cell}-${cellIndex}`}
                    className={cn("text-sm", cellIndex > 0 && "text-right")}
                  >
                    {cell}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={headers.length}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  {emptyMessage}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
          <tfoot>
            <TableRow className="border-t border-border bg-muted/40">
              <TableCell colSpan={headers.length - 1} className="text-right text-sm font-medium">
                {totalLabel}
              </TableCell>
              <TableCell className="text-right text-sm font-medium text-primary">
                {totalValue}
              </TableCell>
            </TableRow>
          </tfoot>
        </Table>
      </CardContent>
    </Card>
  );
}

function splitServiceNames(value: string) {
  return value
    .split(",")
    .map((service) => service.trim())
    .filter(Boolean);
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
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [isSelectingCustomRange, setIsSelectingCustomRange] = useState(false);
  const selectedRange = from
    ? { from: isoDateToCalendarDate(from), to: to ? isoDateToCalendarDate(to) : undefined }
    : undefined;
  const [draftRange, setDraftRange] = useState<DateRange | undefined>(selectedRange);
  const [calendarMonth, setCalendarMonth] = useState<Date>(
    () => selectedRange?.from ?? isoDateToCalendarDate(manilaNow().date),
  );
  const draftFrom = draftRange?.from ? calendarDateToIso(draftRange.from) : "";
  const draftTo = draftRange?.to ? calendarDateToIso(draftRange.to) : "";
  const draftRangeError =
    !draftFrom || !draftTo
      ? "Select both a start and end date."
      : draftFrom > draftTo
        ? "The end date must be on or after the start date."
        : undefined;

  useEffect(() => {
    if (!isSelectingCustomRange || customDialogOpen) return;
    const timeout = window.setTimeout(() => setCustomDialogOpen(true), 0);
    return () => window.clearTimeout(timeout);
  }, [customDialogOpen, isSelectingCustomRange]);

  function startCustomRangeSelection() {
    setIsSelectingCustomRange(true);
    setDraftRange(selectedRange);
    setCalendarMonth(selectedRange?.from ?? isoDateToCalendarDate(manilaNow().date));
  }

  function handlePeriodValueChange(nextValue: string) {
    const nextPeriod = nextValue as PeriodPreset;
    if (nextPeriod !== "custom") {
      setIsSelectingCustomRange(false);
      onValueChange(nextPeriod);
      setCustomDialogOpen(false);
      return;
    }

    startCustomRangeSelection();
  }

  function cancelCustomRange() {
    setDraftRange(selectedRange);
    setIsSelectingCustomRange(false);
    setCustomDialogOpen(false);
  }

  function updateDraftDate(boundary: "from" | "to", value: string) {
    const date = value ? isoDateToCalendarDate(value) : undefined;
    setDraftRange((current) => {
      const next =
        boundary === "from" ? { from: date, to: current?.to } : { from: current?.from, to: date };
      return next.from || next.to ? next : undefined;
    });
    if (date) setCalendarMonth(date);
  }

  return (
    <div className="space-y-1.5">
      <Select
        value={isSelectingCustomRange ? "custom" : value}
        onValueChange={handlePeriodValueChange}
      >
        <SelectTrigger aria-label="Select report period" aria-invalid={Boolean(error)}>
          <CalendarRange className="mr-2 size-4 shrink-0 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {periodOptions.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Dialog
        open={customDialogOpen}
        onOpenChange={(nextOpen) => {
          if (nextOpen) {
            setCustomDialogOpen(true);
            return;
          }
          cancelCustomRange();
        }}
      >
        <DialogContent className="w-auto max-w-[calc(100vw-2rem)] p-4 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display uppercase">Custom date range</DialogTitle>
            <DialogDescription>Select a start date and an end date.</DialogDescription>
          </DialogHeader>
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
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="report-custom-start-date">Start date</Label>
              <Input
                id="report-custom-start-date"
                type="date"
                value={draftFrom}
                max={draftTo || undefined}
                aria-invalid={Boolean(draftRangeError)}
                onChange={(event) => updateDraftDate("from", event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="report-custom-end-date">End date</Label>
              <Input
                id="report-custom-end-date"
                type="date"
                value={draftTo}
                min={draftFrom || undefined}
                aria-invalid={Boolean(draftRangeError)}
                onChange={(event) => updateDraftDate("to", event.target.value)}
              />
            </div>
          </div>
          <FieldError message={draftRangeError} />
          <DialogFooter className="mt-1 border-t border-border pt-3">
            <Button type="button" variant="outline" onClick={cancelCustomRange}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={Boolean(draftRangeError)}
              onClick={() => {
                if (draftRangeError) return;
                const range = calendarRangeToIso(draftRange);
                if (!range) return;
                setIsSelectingCustomRange(false);
                onRangeChange(range);
                setCustomDialogOpen(false);
              }}
            >
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <FieldError message={error} />
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
  if (input.reportKind === "financial") {
    const { data, error } = await supabase.rpc("get_completed_financial_report_page", {
      p_from: input.from,
      p_to: input.to,
      p_category: input.category === "all" ? null : input.category,
      p_service_name: input.serviceName === "all" ? null : input.serviceName,
      p_limit: input.limit,
      p_offset: input.offset,
    });
    if (error) throw error;
    if (!data || typeof data !== "object" || !Array.isArray((data as FinancialReportPage).rows)) {
      throw new Error("The financial report response was incomplete.");
    }
    return data as unknown as FinancialReportPage;
  }

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
  if (!data || typeof data !== "object" || !Array.isArray((data as ReportPage).rows)) {
    throw new Error("The report response was incomplete.");
  }
  return data as unknown as ReportPage;
}

async function getAllReportRows(
  input: Omit<Parameters<typeof getReportPage>[0], "limit" | "offset">,
) {
  const limit = 250;
  let offset = 0;
  let first: FinancialReportPage | ReportPage | null = null;
  let rows: Array<FinancialTransactionRow | BookingRow | ServiceRow> = [];
  do {
    const current = await getReportPage({ ...input, limit, offset });
    first ??= current;
    if (current.rows.length === 0 && offset < current.total) {
      throw new Error("The report printout could not retrieve all matching rows.");
    }
    rows = rows.concat(current.rows);
    offset += current.rows.length;
  } while (first && offset < first.total);
  return {
    rows,
    total: first?.total ?? 0,
    metrics: first?.metrics,
    financial: input.reportKind === "financial" ? (first as FinancialReportPage | null) : undefined,
  };
}

function makeReportData(
  reportKind: ReportKind,
  rows: Array<FinancialTransactionRow | BookingRow | ServiceRow>,
  metrics?: FinancialMetrics | ReportMetrics,
  options: { hasCompleteRows?: boolean } = {},
): ReportData {
  if (reportKind === "financial") {
    const financialRows = rows as FinancialTransactionRow[];
    const financialMetrics = metrics as FinancialMetrics | undefined;
    const serviceAmount = sumMoney(financialRows.map((row) => row.service_amount));
    const productAmount = sumMoney(financialRows.map((row) => row.product_amount));
    const totalAmount = sumMoney(financialRows.map((row) => row.total_amount));
    return {
      headers: [
        "Reference",
        "Date",
        "Services",
        "Products",
        "Service Amount",
        "Product Amount",
        "Total Amount",
      ],
      rows: financialRows.map((row) => [
        row.reference_code,
        formatDateLong(row.transaction_date),
        row.services || "-",
        row.products || "-",
        formatPHP(row.service_amount),
        formatPHP(row.product_amount),
        formatPHP(row.total_amount),
      ]),
      cards: [
        {
          label: "Total revenue",
          value: formatPHP(
            options.hasCompleteRows
              ? totalAmount
              : (financialMetrics?.total_revenue ?? totalAmount),
          ),
          detail: "Completed transactions only",
          tone: "success",
        },
        {
          label: "Service revenue",
          value: formatPHP(
            options.hasCompleteRows
              ? serviceAmount
              : (financialMetrics?.service_revenue ?? serviceAmount),
          ),
          detail: "Completed service charges",
          tone: "primary",
        },
        {
          label: "Product revenue",
          value: formatPHP(
            options.hasCompleteRows
              ? productAmount
              : (financialMetrics?.product_revenue ?? productAmount),
          ),
          detail: "Products sold during service",
          tone: "accent",
        },
        {
          label: "Completed transactions",
          value: String(
            options.hasCompleteRows
              ? financialRows.length
              : (financialMetrics?.completed_transactions ?? financialRows.length),
          ),
          detail: "Revenue-recognized appointments",
          tone: "chart",
        },
      ],
      totalAmount,
    };
  }
  if (reportKind === "services") {
    const legacyMetrics = metrics as ReportMetrics | undefined;
    const serviceRows = rows as ServiceRow[];
    const completedRows = serviceRows.filter((row) => row.status === "completed");
    const completeValue = sumMoney(completedRows.map((row) => row.price));
    const selectedAmount = sumMoney(serviceRows.map((row) => row.price));
    const totalAmount = options.hasCompleteRows
      ? selectedAmount
      : legacyMetrics?.total_value === undefined
        ? selectedAmount
        : moneyValue(legacyMetrics.total_value);
    return {
      headers: ["Reference", "Customer", "Date", "Status", "Service", "Category", "Value"],
      rows: serviceRows.map((row) => [
        row.reference_code,
        row.customer_name,
        formatDateLong(row.appointment_date),
        statusLabel(row.status),
        row.service_name,
        row.category,
        formatPHP(row.price),
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
          value: String(legacyMetrics?.total_bookings ?? 0),
          detail: "Bookings represented",
          tone: "chart",
        },
        {
          label: "Completed entries",
          value: String(
            options.hasCompleteRows ? completedRows.length : (legacyMetrics?.completed_rows ?? 0),
          ),
          detail: "Jobs with status Completed",
          tone: "success",
        },
        {
          label: "Completed value",
          value: formatPHP(
            options.hasCompleteRows ? completeValue : (legacyMetrics?.completed_value ?? 0),
          ),
          detail: "Value from completed jobs",
          tone: "accent",
        },
      ],
      totalAmount,
    };
  }
  const legacyMetrics = metrics as ReportMetrics | undefined;
  const bookingRows = rows as BookingRow[];
  const completedBookings = bookingRows.filter((row) => row.status === "completed");
  const completedValue = sumMoney(completedBookings.map(bookingTotal));
  const selectedServiceSubtotal = sumMoney(bookingRows.map(bookingServiceSubtotal));
  const selectedProductSubtotal = sumMoney(bookingRows.map(bookingProductSubtotal));
  const selectedAmount = sumMoney(bookingRows.map(bookingTotal));
  const totalAmount = options.hasCompleteRows
    ? selectedAmount
    : legacyMetrics?.total_value === undefined
      ? selectedAmount
      : moneyValue(legacyMetrics.total_value);
  return {
    headers: [
      "Reference",
      "Customer",
      "Date",
      "Status",
      "Services",
      "Products",
      "Service subtotal",
      "Product subtotal",
      "Total",
    ],
    rows: bookingRows.map((row) => [
      row.reference_code,
      row.customer_name,
      formatDateLong(row.appointment_date),
      statusLabel(row.status),
      row.service || "—",
      row.products || "—",
      formatPHP(bookingServiceSubtotal(row)),
      formatPHP(bookingProductSubtotal(row)),
      formatPHP(bookingTotal(row)),
    ]),
    cards: [
      {
        label: "Total bookings",
        value: String(legacyMetrics?.total_bookings ?? 0),
        detail: "All bookings in selected period",
        tone: "primary",
      },
      {
        label: "Service charges",
        value: formatPHP(
          options.hasCompleteRows
            ? selectedServiceSubtotal
            : (legacyMetrics?.service_total ?? selectedServiceSubtotal),
        ),
        detail: "Service subtotal",
        tone: "primary",
      },
      {
        label: "Product charges",
        value: formatPHP(
          options.hasCompleteRows
            ? selectedProductSubtotal
            : (legacyMetrics?.product_total ?? selectedProductSubtotal),
        ),
        detail: "Products recorded during service",
        tone: "accent",
      },
      {
        label: "Completed amount",
        value: formatPHP(
          options.hasCompleteRows ? completedValue : (legacyMetrics?.completed_value ?? 0),
        ),
        detail: "Service and product charges for completed jobs",
        tone: "success",
      },
    ],
    totalAmount,
  };
}

function bookingServiceSubtotal(row: BookingRow) {
  return moneyValue(row.service_subtotal ?? row.total_estimate);
}

function bookingProductSubtotal(row: BookingRow) {
  return moneyValue(row.product_subtotal);
}

function bookingTotal(row: BookingRow) {
  return moneyValue(row.total_amount ?? bookingServiceSubtotal(row) + bookingProductSubtotal(row));
}

function moneyValue(value: number | string | null | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sumMoney(values: Array<number | string | null | undefined>) {
  return values.reduce<number>((total, value) => total + moneyValue(value), 0);
}

function formatRevenuePeriod(period: string, kind: "daily" | "monthly") {
  const date = isoDateToCalendarDate(period);
  return format(date, kind === "daily" ? "MMM d, yyyy" : "MMMM yyyy");
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

function formatDateRange(from: string, to: string) {
  if (!from) return "Select custom dates";

  const fromDate = isoDateToCalendarDate(from);
  const fromLabel = format(fromDate, "MMM d, yyyy");
  if (!to) return `${fromLabel} to Select end date`;

  const toDate = isoDateToCalendarDate(to);
  return fromDate.getFullYear() === toDate.getFullYear()
    ? `${format(fromDate, "MMM d")} to ${format(toDate, "MMM d, yyyy")}`
    : `${fromLabel} to ${format(toDate, "MMM d, yyyy")}`;
}

function periodRange(preset: Exclude<PeriodPreset, "custom">, today: string) {
  if (preset === "today") return { from: today, to: today };
  if (preset === "this_week") {
    return manilaWeekDateRange(today);
  }
  if (preset === "this_year") return manilaYearDateRange(today);
  return manilaMonthDateRange(today);
}

/* Removed file-export implementation. Reports now use the browser print system.
async function addReportPdfFont(doc: import("jspdf").jsPDF) {
  const response = await fetch(reportPdfFontUrl);
  if (!response.ok) throw new Error("Could not load the PDF export font.");

  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  doc.addFileToVFS(REPORT_PDF_FONT_FILE, binary);
  doc.addFont(REPORT_PDF_FONT_FILE, REPORT_PDF_FONT, "normal");
  doc.addFont(REPORT_PDF_FONT_FILE, REPORT_PDF_FONT, "bold");
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
  await addReportPdfFont(doc);
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
      doc.setFont(REPORT_PDF_FONT, "bold");
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
    doc.setFont(REPORT_PDF_FONT, "bold");
    doc.setTextColor(...colors.white);
    doc.setFontSize(15);
    doc.text(SHOP_EXPORT_NAME, margin + 51, 21);
    doc.setFont(REPORT_PDF_FONT, "normal");
    doc.setFontSize(7.5);
    doc.text(SHOP.tagline, margin + 51, 27);
    doc.setFont(REPORT_PDF_FONT, "bold");
    doc.setFontSize(13);
    doc.text(title.toUpperCase(), pageWidth - margin - 5, 20, { align: "right" });
    doc.setFont(REPORT_PDF_FONT, "normal");
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
  doc.setFont(REPORT_PDF_FONT, "bold");
  doc.setTextColor(...colors.ink);
  doc.setFontSize(7);
  doc.text("REPORT PERIOD", margin + 14, periodY + 6);
  doc.setFont(REPORT_PDF_FONT, "bold");
  doc.setFontSize(10.5);
  doc.text(`${formatDateRange(from, to)}`, margin + 14, periodY + 11.5);
  doc.setFont(REPORT_PDF_FONT, "normal");
  doc.setFontSize(5.6);
  const scopeLines = doc.splitTextToSize(`Filters: ${scope}`, pageWidth - margin * 2 - 28);
  doc.text(scopeLines, margin + 14, periodY + 16);

  const drawSectionHeading = (label: string, y: number) => {
    doc.setFont(REPORT_PDF_FONT, "bold");
    doc.setFontSize(9);
    doc.setTextColor(...colors.ink);
    doc.text(label.toUpperCase(), margin + 10, y);
    doc.setDrawColor(...colors.primary);
    doc.setLineWidth(0.45);
    doc.line(margin + 52, y - 1, pageWidth - margin, y - 1);
  };

  drawSectionHeading("Report summary", 75);
  const summaryColumns = [margin + 10, pageWidth / 2 + 2];
  const summaryRows = [
    [data.cards[0], data.cards[1]],
    [data.cards[2], data.cards[3]],
  ];
  summaryRows.forEach((row, rowIndex) => {
    row.forEach((card, columnIndex) => {
      if (!card) return;
      const x = summaryColumns[columnIndex]!;
      const y = 84 + rowIndex * 10;
      doc.setTextColor(...colors.ink);
      doc.setFont(REPORT_PDF_FONT, "bold");
      doc.setFontSize(8.5);
      doc.text(`${card.label}:`, x, y);
      doc.setFont(REPORT_PDF_FONT, "normal");
      doc.text(card.value, x + doc.getTextWidth(`${card.label}: `), y);
    });
  });

  drawSectionHeading(
    reportKind === "services" ? "Service entries" : "Bookings for selected period",
    107,
  );
  autoTable(doc, {
    startY: 111,
    head: [data.headers],
    body: data.rows,
    foot: [
      [
        {
          content: "TOTAL AMOUNT",
          colSpan: data.headers.length - 1,
          styles: { halign: "right" },
        },
        { content: formatPHP(data.totalAmount), styles: { halign: "right" } },
      ],
    ],
    showFoot: "lastPage",
    theme: "grid",
    margin: { left: margin, right: margin, top: 27, bottom: 34 },
    styles: {
      font: REPORT_PDF_FONT,
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
    footStyles: {
      fillColor: colors.muted,
      textColor: colors.ink,
      fontStyle: "bold",
      fontSize: 8,
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
            3: { cellWidth: 54, overflow: "linebreak" },
            4: { cellWidth: 29, halign: "center" },
            5: { cellWidth: 55, halign: "right", overflow: "linebreak" },
          },
    didParseCell: (hook) => {
      const statusIndex = data.headers.indexOf("Status");
      if (hook.section === "foot") {
        hook.cell.styles.halign = "right";
      }
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
  // The total is the final table row, directly beneath the Amount column. Keep
  // the sign-off area on its own continuation page if the table leaves too
  // little room for it.
  if (finalY + 18 > signatureTop) {
    doc.addPage();
    drawHeader(true);
  }

  doc.setFont(REPORT_PDF_FONT, "normal");
  doc.setFontSize(7);
  doc.text("Prepared By", margin + 2, signatureTop);
  doc.setDrawColor(...colors.border);
  doc.line(margin + 2, signatureTop + 14, margin + 72, signatureTop + 14);
  doc.text("Approved By", pageWidth - margin - 72, signatureTop);
  doc.setFont(REPORT_PDF_FONT, "bold");
  doc.text(SHOP_OWNER_NAME, pageWidth - margin - 36, signatureTop + 6, { align: "center" });
  doc.setFont(REPORT_PDF_FONT, "normal");
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
    TableLayoutType,
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
      (header, index) =>
        new TableCell({
          shading: { fill: "372B1F" },
          margins: { top: 90, bottom: 90, left: 90, right: 90 },
          children: [
            new Paragraph({
              alignment:
                index === data.headers.length - 1 ? AlignmentType.RIGHT : AlignmentType.LEFT,
              children: [text(header, { bold: true, color: "FFFFFF", size: 16 })],
            }),
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
  const totalRow = new TableRow({
    children: [
      new TableCell({
        columnSpan: data.headers.length - 1,
        shading: { fill: "F6F1E7" },
        margins: { top: 90, bottom: 90, left: 90, right: 90 },
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [text("TOTAL AMOUNT", { bold: true, size: 16, color: "372B1F" })],
          }),
        ],
      }),
      new TableCell({
        shading: { fill: "F6F1E7" },
        margins: { top: 90, bottom: 90, left: 90, right: 90 },
        children: [
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: [
              text(formatPHP(data.totalAmount), { bold: true, size: 16, color: "B9841A" }),
            ],
          }),
        ],
      }),
    ],
  });
  const exportColumnWidths =
    reportKind === "services"
      ? [1859, 2434, 2562, 1729, 2690, 2177, 2243]
      : [2207, 2712, 3217, 3280, 1847, 2441];
  const noBorders = {
    top: { style: BorderStyle.NONE, color: "FFFFFF", size: 0 },
    bottom: { style: BorderStyle.NONE, color: "FFFFFF", size: 0 },
    left: { style: BorderStyle.NONE, color: "FFFFFF", size: 0 },
    right: { style: BorderStyle.NONE, color: "FFFFFF", size: 0 },
    insideHorizontal: { style: BorderStyle.NONE, color: "FFFFFF", size: 0 },
    insideVertical: { style: BorderStyle.NONE, color: "FFFFFF", size: 0 },
  };
  const summaryCell = (card: ExportSummaryCard) =>
    new TableCell({
      margins: { top: 60, bottom: 60, left: 90, right: 90 },
      children: [
        new Paragraph({
          children: [
            text(`${card.label}: `, { bold: true, size: 15, color: "372B1F" }),
            text(card.value, { size: 15, color: "372B1F" }),
          ],
        }),
      ],
    });
  const summaryCards = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [7852, 7852],
    borders: noBorders,
    rows: [
      new TableRow({ children: [summaryCell(data.cards[0]!), summaryCell(data.cards[1]!)] }),
      new TableRow({ children: [summaryCell(data.cards[2]!), summaryCell(data.cards[3]!)] }),
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
            columnWidths: exportColumnWidths,
            layout: TableLayoutType.FIXED,
            borders: tableBorders,
            rows: [headerRow, ...rows, totalRow],
          }),
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
*/

const REPORT_PRINT_STYLES = `
  .report-print-root { display: none; }

  @page { size: A4 landscape; margin: 12mm; }

  @media print {
    body * { visibility: hidden !important; }
    .report-print-root,
    .report-print-root * { visibility: visible !important; }
    .report-print-root {
      position: fixed;
      inset: 0;
      display: block !important;
      width: 100%;
      min-height: 100%;
      background: #fff;
      color: #1f2937;
      font-family: Arial, Helvetica, sans-serif;
    }
    .report-print-document { width: 100%; }
    .report-print-header,
    .report-print-meta,
    .report-print-summary,
    .report-print-footer { break-inside: avoid; }
    .report-print-header {
      display: grid;
      grid-template-columns: 34mm 1fr 42mm;
      align-items: center;
      gap: 8mm;
    }
    .report-print-logo { width: 31mm; height: auto; object-fit: contain; }
    .report-print-heading { text-align: center; }
    .report-print-heading p { margin: 0; font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; }
    .report-print-heading p:nth-child(2) { margin-top: 1mm; font-size: 7pt; letter-spacing: .03em; text-transform: none; }
    .report-print-heading h1 { margin: 3mm 0 2mm; font-size: 18pt; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .report-print-heading p:last-child { font-size: 7pt; font-weight: 700; }
    .report-print-generated { margin: 0; text-align: right; font-size: 7pt; line-height: 1.45; color: #4b5563; }
    .report-print-rule { height: 1.25pt; margin: 5mm 0 4mm; background: #0f5b49; }
    .report-print-meta { display: grid; grid-template-columns: 1fr 1fr; gap: 8mm; font-size: 8pt; }
    .report-print-meta div:last-child { text-align: right; }
    .report-print-meta span,
    .report-print-summary span { display: block; color: #4b5563; font-size: 7pt; text-transform: uppercase; letter-spacing: .04em; }
    .report-print-meta strong { display: block; margin-top: 1mm; font-size: 9pt; font-weight: 600; }
    .report-print-section { margin-top: 6mm; }
    .report-print-section h2 { margin: 0 0 3mm; font-size: 11pt; font-weight: 700; }
    .report-print-summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); border-top: .75pt solid #9ca3af; border-bottom: .75pt solid #9ca3af; }
    .report-print-summary-grid > div { min-height: 17mm; padding: 3mm; border-right: .75pt solid #d1d5db; }
    .report-print-summary-grid > div:last-child { border-right: 0; }
    .report-print-summary-grid strong { display: block; margin-top: 1.5mm; font-size: 12pt; }
    .report-print-summary-grid small { display: block; margin-top: 1mm; color: #4b5563; font-size: 7pt; }
    .report-print-table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 7.5pt; }
    .report-print-table thead { display: table-header-group; background: #e5e7eb; }
    .report-print-table th,
    .report-print-table td { border: .75pt solid #6b7280; padding: 2.25mm 2mm; vertical-align: top; overflow-wrap: anywhere; }
    .report-print-table th { font-size: 7pt; text-align: left; font-weight: 700; }
    .report-print-table th:last-child,
    .report-print-table td:last-child { text-align: right; }
    .report-print-table tr { break-inside: avoid; }
    .report-print-table tbody tr:nth-child(even) { background: #f9fafb; }
    .report-print-table tfoot { display: table-row-group; font-weight: 700; background: #f3f4f6; }
    .report-print-table tfoot td:first-child { text-align: right; text-transform: uppercase; }
    .report-print-footer { display: grid; grid-template-columns: 1fr 1fr; gap: 30mm; margin-top: 16mm; font-size: 8pt; }
    .report-print-footer > div:last-child { text-align: right; }
    .report-print-footer span,
    .report-print-footer small { display: block; color: #4b5563; }
    .report-print-footer strong { display: block; margin-top: 6mm; }
    .report-print-footer div > div { margin-top: 2mm; border-bottom: .75pt solid #374151; }
    .report-print-timestamp { margin: 9mm 0 0; text-align: center; color: #6b7280; font-size: 7pt; }
  }
`;

function PrintReport({ payload }: { payload: PrintPayload | null }) {
  if (!payload) return null;

  const tableTitle =
    payload.reportKind === "financial"
      ? "Completed transactions"
      : payload.reportKind === "services"
        ? "Service entries"
        : "Financial details for selected period";

  return (
    <div className="report-print-root">
      <style>{REPORT_PRINT_STYLES}</style>
      <article className="report-print-document">
        <header className="report-print-header">
          <img src={exportLogoUrl} alt="" className="report-print-logo" />
          <div className="report-print-heading">
            <p>{SHOP_EXPORT_NAME}</p>
            <p>{SHOP.tagline}</p>
            <h1>{payload.title}</h1>
            <p>Reporting summary</p>
          </div>
          <p className="report-print-generated">
            Generated
            <br />
            {payload.generatedAt}
          </p>
        </header>
        <div className="report-print-rule" />
        <section className="report-print-meta">
          <div>
            <span>Coverage</span>
            <strong>{payload.period}</strong>
          </div>
          <div>
            <span>Report scope</span>
            <strong>{payload.scope}</strong>
          </div>
        </section>
        <section className="report-print-section report-print-summary">
          <h2>Report summary</h2>
          <div className="report-print-summary-grid">
            {payload.data.cards.map((card) => (
              <div key={card.label}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            ))}
          </div>
        </section>
        {payload.financial && (
          <>
            <PrintSimpleTable
              title="Service performance"
              headers={["Service", "Completed", "Revenue"]}
              rows={payload.financial.servicePerformance.map((row) => [
                row.service_name,
                String(row.completed_count),
                formatPHP(row.revenue),
              ])}
              emptyMessage="No completed services match this report selection."
            />
            <PrintSimpleTable
              title="Product sales"
              headers={["Product", "Qty Sold", "Unit Price", "Total Sales"]}
              rows={payload.financial.productSales.map((row) => [
                row.product_name,
                String(row.quantity_sold),
                formatPHP(row.unit_price),
                formatPHP(row.total_sales),
              ])}
              emptyMessage="No products were sold in completed transactions for this period."
            />
            <PrintSimpleTable
              title={payload.financial.revenueTitle}
              headers={[
                "Period",
                "Transactions",
                "Service Revenue",
                "Product Revenue",
                "Total Revenue",
              ]}
              rows={payload.financial.revenueRows.map((row) => [
                formatRevenuePeriod(
                  row.period,
                  payload.financial?.revenueTitle === "Daily revenue" ? "daily" : "monthly",
                ),
                String(row.completed_transactions),
                formatPHP(row.service_revenue),
                formatPHP(row.product_revenue),
                formatPHP(row.total_revenue),
              ])}
              emptyMessage="No completed revenue is available for this period."
            />
          </>
        )}
        <section className="report-print-section">
          <h2>{tableTitle}</h2>
          <table className="report-print-table">
            <thead>
              <tr>
                {payload.data.headers.map((header) => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {payload.data.rows.map((row, index) => (
                <tr key={`${row.join("-")}-${index}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${cell}-${cellIndex}`}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={payload.data.headers.length - 1}>Total amount</td>
                <td>{formatPHP(payload.data.totalAmount)}</td>
              </tr>
            </tfoot>
          </table>
        </section>
        <footer className="report-print-footer">
          <div>
            <span>Prepared by</span>
            <div />
          </div>
          <div>
            <span>Approved by</span>
            <strong>{SHOP_OWNER_NAME}</strong>
            <small>Shop Owner</small>
            <div />
          </div>
        </footer>
        <p className="report-print-timestamp">Generated on {payload.generatedAt}</p>
      </article>
    </div>
  );
}

function PrintSimpleTable({
  title,
  headers,
  rows,
  emptyMessage,
}: {
  title: string;
  headers: string[];
  rows: string[][];
  emptyMessage: string;
}) {
  return (
    <section className="report-print-section">
      <h2>{title}</h2>
      <table className="report-print-table">
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.join("-")}-${index}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${cell}-${cellIndex}`}>{cell}</td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={headers.length}>{emptyMessage}</td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
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
