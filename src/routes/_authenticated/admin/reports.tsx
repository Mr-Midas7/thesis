import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { format } from "date-fns";
import {
  BarChart3,
  CalendarDays,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Filter,
  Info,
  ListFilter,
  Printer,
  RotateCcw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { useEffect, useMemo, useState } from "react";

import {
  AdminPage,
  DataList,
  type DataListColumn,
  InlineAlert,
  ListCard,
  ListCardTitle,
  ListEmpty,
  ListToolbar,
  ToolbarFilters,
} from "@/components/admin/data-list";
import { PageHeader } from "@/components/admin/page-header";
import { PrintDocument, PrintTable } from "@/components/admin/print-document";
import { PaginationControls } from "@/components/admin/pagination-controls";
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
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
  manilaYearDateRange,
} from "@/lib/admin-date-range";
import { recordAdminActivityEvent } from "@/lib/admin-activity";
import { formatBusinessTimestamp } from "@/lib/export-branding";
import { usePrintWhenReady } from "@/lib/print-document";
import { formatDateLong, formatPHP, manilaNow } from "@/lib/shop";
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

type PeriodPreset = (typeof periodOptions)[number]["value"];
type ReportFilters = {
  periodPreset: PeriodPreset;
  from: string;
  to: string;
  category: string;
  /** Empty means all services. */
  serviceNames: string[];
};

type CatalogService = { id: string; name: string; category: string };
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
  scope: string;
  title: string;
  financial: {
    servicePerformance: ServicePerformanceRow[];
    productSales: ProductSalesRow[];
    dailyRevenue: RevenuePeriodRow[];
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
  const { from, to, category, serviceNames } = filters;
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
    queryKey: ["reports", { from, to, category, serviceNames, page }],
    queryFn: () =>
      getReportPage({
        from,
        to,
        category,
        serviceNames,
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
  const financialReport = data.data;
  const metrics = financialReport?.metrics;
  const reportData = makeReportData(financialReport?.rows ?? [], metrics);
  const reportTitle = "Financial Report";
  const revenueRows =
    revenuePeriod === "daily"
      ? (financialReport?.daily_revenue ?? [])
      : (financialReport?.monthly_revenue ?? []);
  const appliedFilters = [
    { label: "Completed on", value: formatDateRange(from, to) },
    { label: "Service category", value: category === "all" ? "All categories" : category },
    {
      label: serviceNames.length > 1 ? "Services" : "Specific service",
      value: serviceNames.length ? serviceNames.join(", ") : "All services",
    },
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

  usePrintWhenReady(printPayload && `${printPayload.title} - ${printPayload.period}`, () =>
    setPrintPayload(null),
  );

  async function printReport() {
    if (isPrinting) return;
    setIsPrinting(true);
    try {
      setPrintError(null);
      const allRows = await getAllReportRows({ from, to, category, serviceNames });
      // Print totals and completed metrics are derived from the complete
      // filtered result set, not the currently visible paginated page.
      const completeReportData = makeReportData(allRows.rows, allRows.metrics, {
        hasCompleteRows: true,
      });
      setPrintPayload({
        data: completeReportData,
        generatedAt: formatBusinessTimestamp(),
        period: formatDateRange(from, to),
        scope: reportScope,
        title: reportTitle,
        financial: {
          servicePerformance: allRows.servicePerformance,
          productSales: allRows.productSales,
          dailyRevenue: allRows.dailyRevenue,
        },
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
  const transactionRows: TransactionRow[] = reportData.rows.map((cells, index) => ({
    key: `${cells[0]}-${index}`,
    cells,
  }));

  return (
    <AdminPage>
      <PageHeader
        title="Financial Report"
        description="Track completed revenue, service performance, and product sales for the selected period."
        action={
          <Button
            type="button"
            variant="outline"
            disabled={!data.data?.total || isPrinting}
            className="font-display uppercase"
            onClick={() => void printReport()}
          >
            <Printer /> {isPrinting ? "Preparing print..." : "Print report"}
          </Button>
        }
      />
      {printError && <InlineAlert>{printError}</InlineAlert>}

      <ListToolbar>
        <ToolbarFilters>
          <Select
            value={draftFilters.category}
            onValueChange={(value) =>
              setDraftFilters((current) => ({ ...current, category: value, serviceNames: [] }))
            }
          >
            <SelectTrigger aria-label="Filter by service category" className="w-full sm:w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((value) => (
                <SelectItem key={value} value={value} className="capitalize">
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ServiceMultiSelect
            options={serviceOptions}
            value={draftFilters.serviceNames}
            onChange={(serviceNames) =>
              setDraftFilters((current) => ({ ...current, serviceNames }))
            }
          />
          <div className="col-span-2 sm:w-52">
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
          <Button type="button" onClick={applyFilters} disabled={Boolean(customDateError)}>
            <Filter /> Apply filters
          </Button>
          <Button type="button" variant="outline" onClick={resetFilters}>
            <RotateCcw /> Reset
          </Button>
        </ToolbarFilters>
      </ListToolbar>
      <p className="mb-6 flex items-start gap-2 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
        Only completed appointments count toward revenue. Pending, rejected, cancelled, and
        rescheduled appointments are left out of every total.
      </p>

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
            <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
              {reportScope}
            </p>
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
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
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
          loading={data.isLoading}
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
          loading={data.isLoading}
          emptyMessage="No products were sold in completed transactions for this period."
          totalLabel="Total product revenue"
          totalValue={formatPHP(metrics?.product_revenue ?? 0)}
        />
      </div>

      <ListCard
        className="mb-6"
        header={
          <ListCardTitle
            title="Revenue over time"
            description={`Completed transaction revenue by ${revenuePeriod === "daily" ? "day" : "month"}.`}
            action={
              <div className="flex gap-2" role="group" aria-label="Revenue period">
                <Button
                  type="button"
                  size="sm"
                  variant={revenuePeriod === "daily" ? "default" : "outline"}
                  aria-pressed={revenuePeriod === "daily"}
                  onClick={() => setRevenuePeriod("daily")}
                >
                  Daily
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={revenuePeriod === "monthly" ? "default" : "outline"}
                  aria-pressed={revenuePeriod === "monthly"}
                  onClick={() => setRevenuePeriod("monthly")}
                >
                  Monthly
                </Button>
              </div>
            }
          />
        }
      >
        <DataList
          label="Revenue over time"
          rows={revenueRows}
          rowKey={(row) => row.period}
          loading={data.isLoading}
          loadingRows={3}
          error={
            data.isError
              ? { message: "Could not load revenue.", onRetry: () => void data.refetch() }
              : null
          }
          empty={
            <ListEmpty
              icon={BarChart3}
              title="No completed revenue for this period."
              description="Revenue appears once appointments in this period are completed."
            />
          }
          columns={[
            {
              key: "period",
              header: revenuePeriod === "daily" ? "Date" : "Month",
              card: "title",
              cell: (row) => (
                <span className="font-medium">
                  {formatRevenuePeriod(row.period, revenuePeriod)}
                </span>
              ),
            },
            {
              key: "transactions",
              header: "Transactions",
              className: "w-32 text-right",
              cell: (row) => <span className="text-sm">{row.completed_transactions}</span>,
            },
            {
              key: "service",
              header: "Service revenue",
              className: "w-36 text-right",
              cell: (row) => <span className="text-sm">{formatPHP(row.service_revenue)}</span>,
            },
            {
              key: "product",
              header: "Product revenue",
              className: "w-36 text-right",
              cell: (row) => <span className="text-sm">{formatPHP(row.product_revenue)}</span>,
            },
            {
              key: "total",
              header: "Total revenue",
              className: "w-36 text-right",
              cell: (row) => (
                <span className="text-sm font-medium text-primary">
                  {formatPHP(row.total_revenue)}
                </span>
              ),
            },
          ]}
        />
      </ListCard>

      <ListCard
        header={<ListCardTitle title="Completed Transactions" description={reportScope} />}
        footer={
          <PaginationControls
            page={page}
            pageSize={pageSize}
            total={data.data?.total ?? 0}
            onPageChange={setPage}
          />
        }
      >
        <DataList
          label="Completed transactions"
          rows={transactionRows}
          rowKey={(row) => row.key}
          loading={data.isLoading}
          error={
            data.isError
              ? { message: "Could not load this report.", onRetry: () => void data.refetch() }
              : null
          }
          empty={
            <ListEmpty
              icon={ListFilter}
              title={`No ${rowLabel} match this report selection.`}
              description="Try a different period, category, or service."
            />
          }
          columns={transactionColumns(reportData.headers, (services, referenceCode) =>
            setServiceListDialog({ referenceCode, services }),
          )}
        />
      </ListCard>

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
    </AdminPage>
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
  loading,
  emptyMessage,
  totalLabel,
  totalValue,
}: {
  title: string;
  description: string;
  headers: string[];
  rows: string[][];
  loading: boolean;
  emptyMessage: string;
  totalLabel: string;
  totalValue: string;
}) {
  const items = rows.map((cells, index) => ({ key: `${cells[0]}-${index}`, cells }));
  return (
    <ListCard
      header={<ListCardTitle title={title} description={description} />}
      footer={
        <div className="flex items-center justify-between gap-3 border-t border-border/70 bg-muted/40 px-4 py-3 text-sm font-medium sm:px-5">
          <span>{totalLabel}</span>
          <span className="text-primary">{totalValue}</span>
        </div>
      }
    >
      <DataList
        label={title}
        rows={items}
        rowKey={(item) => item.key}
        loading={loading}
        loadingRows={3}
        empty={<ListEmpty icon={CircleDollarSign} title={emptyMessage} />}
        columns={headers.map((header, index): DataListColumn<(typeof items)[number]> =>
          index === 0
            ? {
                key: header,
                header,
                card: "title",
                cell: (item) => <span className="font-medium">{item.cells[0]}</span>,
              }
            : {
                key: header,
                header,
                className: "w-28 text-right",
                cell: (item) => <span className="text-sm">{item.cells[index]}</span>,
              },
        )}
      />
    </ListCard>
  );
}

type TransactionRow = { key: string; cells: string[] };

/**
 * Columns for the paginated report rows. Cards show every value; the table
 * keeps the reference, date, services, and total, and adds the service and
 * product amounts from `xl` up.
 */
function transactionColumns(
  headers: string[],
  onSeeMore: (services: string[], referenceCode: string) => void,
): DataListColumn<TransactionRow>[] {
  const cellAt = (row: TransactionRow, header: string) => row.cells[headers.indexOf(header)] ?? "";
  const referenceOf = (row: TransactionRow) => row.cells[0] || "this booking";
  const servicesCell = (row: TransactionRow) => (
    <ReportServicesCell
      value={cellAt(row, "Services")}
      referenceCode={referenceOf(row)}
      onSeeMore={(services) => onSeeMore(services, referenceOf(row))}
    />
  );

  return headers.flatMap((header, index): DataListColumn<TransactionRow>[] => {
    const value = (row: TransactionRow) => row.cells[index] ?? "";
    switch (header) {
      case "Reference":
        return [
          {
            key: header,
            header,
            card: "title",
            className: "w-32",
            cell: (row) => <span className="font-mono text-sm font-medium">{value(row)}</span>,
          },
        ];
      case "Date":
        return [
          {
            key: header,
            header,
            className: "w-36",
            cell: (row) => <span className="text-sm">{value(row)}</span>,
          },
        ];
      case "Services":
        return [
          {
            key: header,
            header,
            card: "wide",
            table: false,
            cell: (row) => <span className="text-sm">{servicesCell(row)}</span>,
          },
          {
            key: "services-and-products",
            header: headers.includes("Products") ? "Services & products" : "Services",
            card: false,
            cell: (row) => {
              const products = cellAt(row, "Products");
              return (
                <span className="text-sm">
                  {servicesCell(row)}
                  {products && products !== "-" && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">{products}</span>
                  )}
                </span>
              );
            },
          },
        ];
      case "Products":
        return [
          {
            key: header,
            header,
            card: "wide",
            table: false,
            cell: (row) => <span className="text-sm">{value(row)}</span>,
          },
        ];
      default: {
        const isTotal = /^total/i.test(header);
        return [
          {
            key: header,
            header,
            xlOnly: !isTotal && /amount/i.test(header),
            className: "w-32 text-right",
            cell: (row) => (
              <span className={cn("text-sm", isTotal && "font-medium text-primary")}>
                {value(row)}
              </span>
            ),
          },
        ];
      }
    }
  });
}

function splitServiceNames(value: string) {
  return value
    .split(",")
    .map((service) => service.trim())
    .filter(Boolean);
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
  from: string;
  to: string;
  category: string;
  serviceNames: string[];
  limit: number;
  offset: number;
}) {
  const { data, error } = await supabase.rpc("get_completed_financial_report_page", {
    p_from: input.from,
    p_to: input.to,
    p_category: input.category === "all" ? null : input.category,
    p_service_names: input.serviceNames.length ? input.serviceNames : null,
    p_limit: input.limit,
    p_offset: input.offset,
  });
  if (error) throw error;
  if (!data || typeof data !== "object" || !Array.isArray((data as FinancialReportPage).rows)) {
    throw new Error("The financial report response was incomplete.");
  }
  return data as unknown as FinancialReportPage;
}

/** Every row of the report, for printing, with the breakdowns from the first page. */
async function getAllReportRows(
  input: Omit<Parameters<typeof getReportPage>[0], "limit" | "offset">,
) {
  const limit = 250;
  let offset = 0;
  let first: FinancialReportPage | null = null;
  let rows: FinancialTransactionRow[] = [];
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
    servicePerformance: first?.service_performance ?? [],
    productSales: first?.product_sales ?? [],
    dailyRevenue: first?.daily_revenue ?? [],
  };
}

function makeReportData(
  rows: FinancialTransactionRow[],
  metrics?: FinancialMetrics,
  options: { hasCompleteRows?: boolean } = {},
): ReportData {
  const serviceAmount = sumMoney(rows.map((row) => row.service_amount));
  const productAmount = sumMoney(rows.map((row) => row.product_amount));
  const totalAmount = sumMoney(rows.map((row) => row.total_amount));
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
    rows: rows.map((row) => [
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
          options.hasCompleteRows ? totalAmount : (metrics?.total_revenue ?? totalAmount),
        ),
        detail: "Completed transactions only",
        tone: "success",
      },
      {
        label: "Service revenue",
        value: formatPHP(
          options.hasCompleteRows ? serviceAmount : (metrics?.service_revenue ?? serviceAmount),
        ),
        detail: "Completed service charges",
        tone: "primary",
      },
      {
        label: "Product revenue",
        value: formatPHP(
          options.hasCompleteRows ? productAmount : (metrics?.product_revenue ?? productAmount),
        ),
        detail: "Products sold during service",
        tone: "accent",
      },
      {
        label: "Completed transactions",
        value: String(
          options.hasCompleteRows ? rows.length : (metrics?.completed_transactions ?? rows.length),
        ),
        detail: "Revenue-recognized appointments",
        tone: "chart",
      },
    ],
    totalAmount,
  };
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
    serviceNames: [],
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

function PrintReport({ payload }: { payload: PrintPayload | null }) {
  if (!payload) return null;

  const { financial } = payload;
  const serviceCompleted = financial.servicePerformance.reduce(
    (total, row) => total + row.completed_count,
    0,
  );
  const serviceRevenue = sumMoney(financial.servicePerformance.map((row) => row.revenue));
  const productsSold = financial.productSales.reduce((total, row) => total + row.quantity_sold, 0);
  const productRevenue = sumMoney(financial.productSales.map((row) => row.total_sales));
  const dailyRevenue = financial.dailyRevenue;
  const dailyRevenueTotals = revenueTotals(dailyRevenue);

  return (
    <PrintDocument
      info={{
        title: payload.title,
        generatedAt: payload.generatedAt,
        coverage: payload.period,
        scope: payload.scope,
      }}
    >
      <section className="report-print-section report-print-summary">
        <h2>A. Financial summary</h2>
        <table className="report-print-summary-table">
          <thead>
            <tr>
              <th>Description</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {payload.data.cards.map((card) => (
              <tr key={card.label}>
                <td>{card.label}</td>
                <td>{card.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <PrintTable
        title="B. Service revenue breakdown"
        headers={["Service", "Completed", "Revenue"]}
        columnWidths={["58%", "18%", "24%"]}
        rows={financial.servicePerformance.map((row) => [
          row.service_name,
          String(row.completed_count),
          formatPHP(row.revenue),
        ])}
        footerRow={["Total service revenue", String(serviceCompleted), formatPHP(serviceRevenue)]}
        emptyMessage="No completed services match this report selection."
      />
      <PrintTable
        title="C. Product sales breakdown"
        headers={["Product", "Qty Sold", "Unit Price", "Total Sales"]}
        columnWidths={["42%", "18%", "20%", "20%"]}
        rows={financial.productSales.map((row) => [
          row.product_name,
          String(row.quantity_sold),
          formatPHP(row.unit_price),
          formatPHP(row.total_sales),
        ])}
        footerRow={["Total product revenue", String(productsSold), "", formatPHP(productRevenue)]}
        emptyMessage="No products were sold in completed transactions for this period."
      />
      <PrintTable
        title="D. Daily revenue"
        headers={["Date", "Transactions", "Service Revenue", "Product Revenue", "Total Revenue"]}
        columnWidths={["26%", "14%", "20%", "20%", "20%"]}
        rows={dailyRevenue.map((row) => [
          formatRevenuePeriod(row.period, "daily"),
          String(row.completed_transactions),
          formatPHP(row.service_revenue),
          formatPHP(row.product_revenue),
          formatPHP(row.total_revenue),
        ])}
        footerRow={[
          "Total daily revenue",
          String(dailyRevenueTotals.transactions),
          formatPHP(dailyRevenueTotals.serviceRevenue),
          formatPHP(dailyRevenueTotals.productRevenue),
          formatPHP(dailyRevenueTotals.totalRevenue),
        ]}
        emptyMessage="No completed revenue is available for this period."
      />
      <section className="report-print-section">
        <h2>E. Completed transactions</h2>
        <table className="report-print-table">
          <colgroup>
            {["10%", "13%", "23%", "16%", "12%", "13%", "13%"].map((width, index) => (
              <col key={`${width}-${index}`} style={{ width }} />
            ))}
          </colgroup>
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
    </PrintDocument>
  );
}

function revenueTotals(rows: RevenuePeriodRow[]) {
  return {
    transactions: rows.reduce((total, row) => total + row.completed_transactions, 0),
    serviceRevenue: sumMoney(rows.map((row) => row.service_revenue)),
    productRevenue: sumMoney(rows.map((row) => row.product_revenue)),
    totalRevenue: sumMoney(rows.map((row) => row.total_revenue)),
  };
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

/** Pick any number of services; none picked means all services. */
function ServiceMultiSelect({
  options,
  value,
  onChange,
}: {
  options: CatalogService[];
  value: string[];
  onChange: (serviceNames: string[]) => void;
}) {
  const label =
    value.length === 0
      ? "All services"
      : value.length === 1
        ? value[0]
        : `${value.length} services`;
  const toggle = (name: string, checked: boolean) =>
    onChange(checked ? [...value, name] : value.filter((item) => item !== name));

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={`Filter by service: ${value.length ? value.join(", ") : "all services"}`}
          className="w-full justify-between font-normal sm:w-52"
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-4 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <p className="text-sm font-medium">
            {value.length ? `${value.length} selected` : "All services"}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            disabled={value.length === 0}
            onClick={() => onChange([])}
          >
            Clear
          </Button>
        </div>
        <ul className="max-h-72 overflow-y-auto p-1">
          {options.map((item) => {
            const id = `report-service-${item.id}`;
            const checked = value.includes(item.name);
            return (
              <li key={item.id}>
                <label
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm hover:bg-muted"
                >
                  <Checkbox
                    id={id}
                    checked={checked}
                    onCheckedChange={(next) => toggle(item.name, next === true)}
                  />
                  <span className="min-w-0 flex-1 truncate" title={item.name}>
                    {item.name}
                  </span>
                </label>
              </li>
            );
          })}
          {options.length === 0 && (
            <li className="px-2 py-3 text-sm text-muted-foreground">
              No services in this category.
            </li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
