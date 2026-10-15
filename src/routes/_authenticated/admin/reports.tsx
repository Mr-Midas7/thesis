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
  Info,
  ListFilter,
  Printer,
  RotateCcw,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import exportLogoUrl from "@/assets/export-logo.png";
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
import { PaginationControls } from "@/components/admin/pagination-controls";
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
import { SHOP, formatDateLong, formatPHP, manilaNow } from "@/lib/shop";
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
  serviceName: string;
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
  const { from, to, category, serviceName } = filters;
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
    queryKey: ["reports", { from, to, category, serviceName, page }],
    queryFn: () =>
      getReportPage({
        from,
        to,
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
  const financialReport = data.data;
  const metrics = financialReport?.metrics;
  const reportData = makeReportData(financialReport?.rows ?? [], metrics);
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
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const root = document.querySelector<HTMLElement>(".report-print-root");
      if (root) {
        // The logo must be decoded before the pages are measured.
        await Promise.all(
          Array.from(root.querySelectorAll("img"), (image) =>
            image.decode().catch(() => undefined),
          ),
        );
        if (cancelled) return;
        paginateReport(root);
      }
      // Shown in the print dialog and used as the "Save as PDF" file name.
      const previousTitle = document.title;
      document.title = `${printPayload.title} - ${printPayload.period}`;
      window.addEventListener("afterprint", () => (document.title = previousTitle), {
        once: true,
      });
      window.print();
      setPrintPayload(null);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [printPayload]);

  async function printReport() {
    if (isPrinting) return;
    setIsPrinting(true);
    try {
      setPrintError(null);
      const allRows = await getAllReportRows({ from, to, category, serviceName });
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
        title="Financial Report (Summary)"
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
              setDraftFilters((current) => ({ ...current, category: value, serviceName: "all" }))
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
          <Select
            value={draftFilters.serviceName}
            onValueChange={(value) =>
              setDraftFilters((current) => ({ ...current, serviceName: value }))
            }
          >
            <SelectTrigger aria-label="Filter by service" className="w-full sm:w-52">
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
  serviceName: string;
  limit: number;
  offset: number;
}) {
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
    serviceName: "all",
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

/** A4 landscape, and the margins on every printed page (millimetres). */
const PRINT_PAGE_MM = { width: 297, height: 210, top: 12, bottom: 15, side: 11 };
/** Sheets are a little shorter than the paper so rounding never spills onto an extra page. */
const PRINT_SHEET_HEIGHT_MM = PRINT_PAGE_MM.height - 1;
/** Content is never filled to the very edge of a sheet. */
const PRINT_SHEET_SAFETY_MM = 2;
const MM_TO_PX = 96 / 25.4;
/** Minimum space between the last table and the signatures. */
const SIGN_OFF_GAP_MM = 10;

/** The part of a report table that is on one sheet. */
type PrintTablePart = {
  section: HTMLElement;
  table: HTMLElement;
  body: HTMLTableSectionElement;
  footer: HTMLElement | null;
  rows: number;
};

/**
 * Lays the report out on fixed A4 sheets, one per printed page, so the page
 * breaks are decided here rather than guessed. Rows and blocks are never split,
 * a section heading stays with its table, and a table's header row repeats on
 * each sheet it continues on. The signatures go at the bottom of the last sheet.
 * When there is not enough room below the content, they go on a new sheet,
 * together with the last row and total of the final table.
 *
 * Fills .report-print-sheets; if anything fails, the sheets stay empty and the
 * report prints as one flowing document instead.
 */
function paginateReport(root: HTMLElement) {
  const sheets = root.querySelector<HTMLElement>(".report-print-sheets");
  const content = root.querySelector<HTMLElement>(".report-print-flow .report-print-content");
  const signOff = root.querySelector<HTMLElement>(".report-print-flow .report-print-signoff");
  if (!sheets || !content || !signOff) return;
  sheets.replaceChildren();

  const pageWidth = (PRINT_PAGE_MM.width - 2 * PRINT_PAGE_MM.side) * MM_TO_PX;
  const pageHeight =
    (PRINT_SHEET_HEIGHT_MM - PRINT_PAGE_MM.top - PRINT_PAGE_MM.bottom - PRINT_SHEET_SAFETY_MM) *
    MM_TO_PX;

  // Measure everything once at the printed width, off screen.
  const probe = document.createElement("article");
  probe.className = "report-print-document";
  Object.assign(probe.style, {
    position: "absolute",
    top: "0",
    left: "-100000px",
    width: `${pageWidth}px`,
    visibility: "hidden",
  });
  const flow = content.cloneNode(true) as HTMLElement;
  const signatures = signOff.cloneNode(true) as HTMLElement;
  probe.append(flow, signatures);
  document.body.append(probe);

  try {
    const height = (element: Element) => element.getBoundingClientRect().height;
    const margin = (element: Element, side: "marginTop" | "marginBottom") =>
      parseFloat(getComputedStyle(element)[side]) || 0;

    let sheet = document.createElement("section");
    let used = 0;
    const newSheet = () => {
      sheet = document.createElement("section");
      sheet.className = "report-print-document report-print-sheet";
      sheets.append(sheet);
      used = 0;
    };
    const fits = (extra: number) => used + extra <= pageHeight;
    newSheet();
    // The part of the final table on the current sheet, if the report ends in one.
    let lastTable: { part: PrintTablePart; continueOnNewSheet: () => PrintTablePart } | null = null;

    for (const block of Array.from(flow.children)) {
      const table = block.querySelector(".report-print-table");
      const rows = table
        ? [
            ...Array.from(table.querySelectorAll(":scope > tbody > tr"), (row) => ({
              row,
              inFooter: false,
            })),
            ...Array.from(table.querySelectorAll(":scope > tfoot > tr"), (row) => ({
              row,
              inFooter: true,
            })),
          ]
        : [];
      const firstRow = rows[0];
      const marginTop = margin(block, "marginTop");

      if (!table || !firstRow) {
        const blockHeight = height(block) + margin(block, "marginBottom");
        if (used > 0 && !fits(marginTop + blockHeight)) newSheet();
        const clone = block.cloneNode(true) as HTMLElement;
        // Space above a block is dropped at the top of a sheet.
        if (used === 0) clone.style.marginTop = "0";
        sheet.append(clone);
        used += (used === 0 ? 0 : marginTop) + blockHeight;
        lastTable = null;
        continue;
      }

      const heading = block.querySelector(":scope > h2");
      const colgroup = table.querySelector(":scope > colgroup");
      const thead = table.querySelector(":scope > thead");
      const headingHeight = heading
        ? height(heading) + margin(heading, "marginTop") + margin(heading, "marginBottom")
        : 0;
      const headerHeight = thead ? height(thead) : 0;

      // The part of this section on one sheet: the heading on the first sheet
      // only, and the table's column widths and header row on every sheet.
      const startPart = (withHeading: boolean) => {
        const section = block.cloneNode(false) as HTMLElement;
        if (used === 0) section.style.marginTop = "0";
        if (withHeading && heading) section.append(heading.cloneNode(true));
        const shell = table.cloneNode(false) as HTMLElement;
        if (colgroup) shell.append(colgroup.cloneNode(true));
        if (thead) shell.append(thead.cloneNode(true));
        const body = shell.appendChild(document.createElement("tbody"));
        section.append(shell);
        sheet.append(section);
        return { section, table: shell, body, footer: null as HTMLElement | null, rows: 0 };
      };

      // The heading, header row, and first row stay together.
      if (used > 0 && !fits(marginTop + headingHeight + headerHeight + height(firstRow.row))) {
        newSheet();
      }
      const sectionStart = (used === 0 ? 0 : marginTop) + headingHeight + headerHeight;
      let part = startPart(true);
      used += sectionStart;

      for (const { row, inFooter } of rows) {
        const rowHeight = height(row);
        if (part.rows > 0 && !fits(rowHeight)) {
          newSheet();
          part = startPart(false);
          used += headerHeight;
        }
        if (inFooter) {
          part.footer ??= part.table.appendChild(document.createElement("tfoot"));
          part.footer.append(row.cloneNode(true));
        } else {
          part.body.append(row.cloneNode(true));
        }
        part.rows += 1;
        used += rowHeight;
      }
      lastTable = { part, continueOnNewSheet: () => startPart(false) };
    }

    if (!fits(SIGN_OFF_GAP_MM * MM_TO_PX + height(signatures))) {
      newSheet();
      // The signatures never sit alone on a page: the final table's last row
      // and total move down with them.
      if (lastTable) {
        const { part } = lastTable;
        const bodyRows = Array.from(part.body.rows);
        const lastRow = bodyRows.at(-1);
        if (bodyRows.length > 1 && lastRow) {
          const moved = lastTable.continueOnNewSheet();
          moved.body.append(lastRow);
          if (part.footer) moved.table.append(part.footer);
        } else {
          part.section.style.marginTop = "0";
          sheet.append(part.section);
        }
      }
    }
    sheet.append(signOff.cloneNode(true));
  } catch (error) {
    console.error("Could not lay out the report pages:", error);
    sheets.replaceChildren();
  } finally {
    probe.remove();
  }
}

const REPORT_PRINT_STYLES = `
  .report-print-root { display: none; }

  /*
   * A zero page margin stops the browser from printing its own header (page
   * title) and footer (URL, page numbers). The .report-print-page table puts
   * the margins back: its header and footer rows repeat on every page.
   */
  @page { size: A4 landscape; margin: 0; }

  @media print {
    html,
    body {
      width: auto !important;
      min-width: 0 !important;
      height: auto !important;
      margin: 0 !important;
      padding: 0 !important;
      background: #fff !important;
    }
    body > :not(.report-print-root) { display: none !important; }
    .report-print-root {
      position: static !important;
      display: block !important;
      width: auto !important;
      min-width: 0 !important;
      min-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: visible !important;
      background: #fff;
    }
  }

  /* Layout and typography. These apply outside print too, so the report can
     be measured before printing (see paginateReport). */
  .report-print-page { width: 100%; border-collapse: collapse; border: 0; }
  .report-print-page > thead > tr > td { height: ${PRINT_PAGE_MM.top}mm; padding: 0; border: 0; }
  .report-print-page > tfoot > tr > td { height: ${PRINT_PAGE_MM.bottom}mm; padding: 0; border: 0; }
  .report-print-page > tbody > tr > td { padding: 0 ${PRINT_PAGE_MM.side}mm; border: 0; vertical-align: top; }
  .report-print-document {
    width: 100%;
    min-width: 0;
    color: #1f2937;
    font-family: Arial, Helvetica, sans-serif;
  }

  /* One sheet per printed page, laid out by paginateReport. Once the sheets
     are there, the flowing copy of the report is not printed. */
  .report-print-sheets:not(:empty) + .report-print-flow { display: none !important; }
  .report-print-sheet {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    width: ${PRINT_PAGE_MM.width}mm;
    height: ${PRINT_SHEET_HEIGHT_MM}mm;
    padding: ${PRINT_PAGE_MM.top}mm ${PRINT_PAGE_MM.side}mm ${PRINT_PAGE_MM.bottom}mm;
    break-after: page;
    page-break-after: always;
  }
  .report-print-sheet:last-child { break-after: auto; page-break-after: auto; }
  .report-print-sheet > * { flex: none; }
  .report-print-sheet > .report-print-signoff { margin-top: auto; padding-top: ${SIGN_OFF_GAP_MM}mm; }
  .report-print-flow .report-print-signoff { margin-top: ${SIGN_OFF_GAP_MM}mm; }
  .report-print-header,
  .report-print-meta,
  .report-print-summary,
  .report-print-signoff {
    break-inside: avoid-page;
    page-break-inside: avoid;
  }
  .report-print-header {
    display: grid;
    grid-template-columns: 26mm minmax(0, 1fr) 36mm;
    align-items: center;
    gap: 6mm;
  }
  .report-print-logo { display: block; width: 24mm; max-width: 100%; height: auto; aspect-ratio: 360 / 202; object-fit: contain; }
  .report-print-heading { min-width: 0; text-align: center; }
  .report-print-heading p { margin: 0; font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; }
  .report-print-heading p:nth-child(2) { margin-top: 1mm; font-size: 7pt; letter-spacing: .03em; text-transform: none; }
  .report-print-heading h1 { margin: 3mm 0 2mm; font-size: 18pt; font-weight: 700; letter-spacing: .04em; overflow-wrap: anywhere; text-transform: uppercase; }
  .report-print-heading p:last-child { font-size: 7pt; font-weight: 700; }
  .report-print-generated { min-width: 0; margin: 0; overflow-wrap: anywhere; text-align: right; font-size: 7pt; line-height: 1.45; color: #4b5563; }
  .report-print-rule { height: 1.25pt; margin: 5mm 0 4mm; background: #0f5b49; }
  .report-print-meta { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8mm; font-size: 8pt; }
  .report-print-meta div:last-child { text-align: right; }
  .report-print-meta span,
  .report-print-summary span { display: block; color: #4b5563; font-size: 7pt; text-transform: uppercase; letter-spacing: .04em; }
  .report-print-meta strong { display: block; margin-top: 1mm; overflow-wrap: anywhere; font-size: 9pt; font-weight: 600; }
  .report-print-section { min-width: 0; margin-top: 6mm; break-inside: auto; page-break-inside: auto; }
  .report-print-section h2 { margin: 0 0 3mm; break-after: avoid-page; page-break-after: avoid; font-size: 11pt; font-weight: 700; }
  .report-print-summary-table { width: 100%; border-collapse: collapse; font-size: 8pt; }
  .report-print-summary-table th,
  .report-print-summary-table td { border: .75pt solid #6b7280; padding: 2.25mm 2mm; }
  .report-print-summary-table th { background: #e5e7eb; font-size: 7pt; text-align: left; text-transform: uppercase; }
  .report-print-summary-table th:last-child,
  .report-print-summary-table td:last-child { text-align: right; }
  .report-print-summary-table tbody tr:last-child td { font-weight: 700; background: #f3f4f6; }
  .report-print-table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 7.5pt; }
  .report-print-table thead { display: table-header-group; break-inside: avoid-page; background: #e5e7eb; }
  .report-print-table th,
  .report-print-table td { box-sizing: border-box; border: .75pt solid #6b7280; padding: 2.25mm 2mm; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
  .report-print-table th { font-size: 7pt; text-align: left; font-weight: 700; }
  .report-print-table th:last-child,
  .report-print-table td:last-child { text-align: right; }
  .report-print-table tr { break-inside: avoid-page; page-break-inside: avoid; }
  .report-print-table tbody tr:nth-child(even) { background: #f9fafb; }
  .report-print-table tfoot { display: table-row-group; break-inside: avoid-page; font-weight: 700; background: #f3f4f6; }
  .report-print-table tfoot td:first-child { text-transform: uppercase; }
  .report-print-footer { display: grid; grid-template-columns: 1fr 1fr; gap: 30mm; font-size: 8pt; }
  .report-print-footer > div:last-child { text-align: right; }
  .report-print-footer span,
  .report-print-footer small { display: block; color: #4b5563; }
  .report-print-footer strong { display: block; margin-top: 6mm; }
  .report-print-footer div > div { margin-top: 2mm; border-bottom: .75pt solid #374151; }
  .report-print-timestamp { margin: 6mm 0 0; text-align: center; color: #6b7280; font-size: 7pt; }
`;

function PrintReport({ payload }: { payload: PrintPayload | null }) {
  if (!payload || typeof document === "undefined") return null;

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

  return createPortal(
    <div className="report-print-root">
      <style>{REPORT_PRINT_STYLES}</style>
      <div className="report-print-sheets" />
      {/* Printed only if the report could not be laid out on sheets. */}
      <table className="report-print-page report-print-flow">
        <thead>
          <tr>
            <td />
          </tr>
        </thead>
        <tfoot>
          <tr>
            <td />
          </tr>
        </tfoot>
        <tbody>
          <tr>
            <td>
              <article className="report-print-document">
                <div className="report-print-content">
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
                  <PrintSimpleTable
                    title="B. Service revenue breakdown"
                    headers={["Service", "Completed", "Revenue"]}
                    columnWidths={["58%", "18%", "24%"]}
                    rows={financial.servicePerformance.map((row) => [
                      row.service_name,
                      String(row.completed_count),
                      formatPHP(row.revenue),
                    ])}
                    footerRow={[
                      "Total service revenue",
                      String(serviceCompleted),
                      formatPHP(serviceRevenue),
                    ]}
                    emptyMessage="No completed services match this report selection."
                  />
                  <PrintSimpleTable
                    title="C. Product sales breakdown"
                    headers={["Product", "Qty Sold", "Unit Price", "Total Sales"]}
                    columnWidths={["42%", "18%", "20%", "20%"]}
                    rows={financial.productSales.map((row) => [
                      row.product_name,
                      String(row.quantity_sold),
                      formatPHP(row.unit_price),
                      formatPHP(row.total_sales),
                    ])}
                    footerRow={[
                      "Total product revenue",
                      String(productsSold),
                      "",
                      formatPHP(productRevenue),
                    ]}
                    emptyMessage="No products were sold in completed transactions for this period."
                  />
                  <PrintSimpleTable
                    title="D. Daily revenue"
                    headers={[
                      "Date",
                      "Transactions",
                      "Service Revenue",
                      "Product Revenue",
                      "Total Revenue",
                    ]}
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
                </div>
                <div className="report-print-signoff">
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
                </div>
              </article>
            </td>
          </tr>
        </tbody>
      </table>
    </div>,
    document.body,
  );
}

function PrintSimpleTable({
  title,
  headers,
  columnWidths,
  rows,
  footerRow,
  emptyMessage,
}: {
  title: string;
  headers: string[];
  columnWidths?: string[];
  rows: string[][];
  footerRow?: string[];
  emptyMessage: string;
}) {
  return (
    <section className="report-print-section">
      <h2>{title}</h2>
      <table className="report-print-table">
        {columnWidths && (
          <colgroup>
            {columnWidths.map((width, index) => (
              <col key={`${width}-${index}`} style={{ width }} />
            ))}
          </colgroup>
        )}
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
        {footerRow && rows.length > 0 && (
          <tfoot>
            <tr>
              {footerRow.map((cell, index) => (
                <td key={`${cell}-${index}`}>{cell}</td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </section>
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
