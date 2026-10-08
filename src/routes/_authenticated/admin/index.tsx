import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { format } from "date-fns";
import {
  BarChart3,
  CalendarCheck,
  CalendarClock,
  CalendarRange,
  ChevronDown,
  ChevronRight,
  Gauge,
  PhilippinePeso,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent } from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";
import {
  calendarDateToIso,
  calendarRangeToIso,
  isoDateToCalendarDate,
  type IsoDateRange,
} from "@/lib/admin-date-range";
import { addDays, formatPHP, formatTime, manilaNow, statusLabel, statusTone } from "@/lib/shop";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/")({
  component: Dashboard,
});

const appointmentChartConfig = {
  completed: { label: "Complete", color: "var(--chart-3)" },
  confirmed: { label: "Confirmed", color: "var(--primary)" },
  cancelled: { label: "Canceled", color: "var(--destructive)" },
  in_progress: { label: "In Progress", color: "var(--chart-4)" },
} satisfies ChartConfig;

const statusChartConfig = {
  pending: { label: "Pending", color: "var(--primary)" },
  confirmed: { label: "Confirmed", color: "var(--chart-3)" },
  in_progress: { label: "In Progress", color: "var(--chart-4)" },
  completed: { label: "Complete", color: "var(--chart-2)" },
  rescheduled: { label: "Rescheduled", color: "var(--chart-5)" },
  cancelled: { label: "Canceled", color: "var(--destructive)" },
  no_show: { label: "No Show", color: "var(--muted-foreground)" },
} satisfies ChartConfig;

type DashboardAppointment = {
  id: string;
  reference_code: string;
  customer_name: string;
  appointment_date: string;
  start_time: string;
  status: string;
  moto_brand: string;
  moto_model: string;
  phone: string;
  total_estimate: number;
  serviceName: string;
  rescheduled_from_appointment_id: string | null;
  rescheduled_to_appointment_id: string | null;
};

type Trend = {
  direction: "up" | "down" | "flat";
  label: string;
  description: string;
};

type OverviewPeriod = "today" | "7d" | "month" | "year" | "custom";

function Dashboard() {
  const today = manilaNow().date;
  const selectedDate = useMemo(() => isoDateToCalendarDate(today), [today]);
  const [dashboardPeriod, setDashboardPeriod] = useState<OverviewPeriod>("today");
  const [dashboardCustomDateRange, setDashboardCustomDateRange] = useState<DateRange>();
  const [chartPeriod, setChartPeriod] = useState<OverviewPeriod>("7d");
  const [chartCustomDateRange, setChartCustomDateRange] = useState<DateRange>();
  const selectedDateIso = calendarDateToIso(selectedDate);

  const data = useQuery({
    queryKey: ["admin-dashboard", selectedDateIso],
    queryFn: async (): Promise<DashboardAppointment[]> => {
      const { data: appointments, error } = await supabase
        .from("appointments")
        .select("*")
        .eq("is_archived", false)
        .order("appointment_date")
        .order("start_time");
      if (error) throw error;

      const { data: appointmentServices } = await supabase
        .from("appointment_services")
        .select("appointment_id,service_name");
      const serviceNamesByAppointment = new Map<string, string[]>();
      for (const service of appointmentServices ?? []) {
        const names = serviceNamesByAppointment.get(service.appointment_id) ?? [];
        names.push(service.service_name);
        serviceNamesByAppointment.set(service.appointment_id, names);
      }

      return (appointments ?? []).map((appointment) => ({
        id: appointment.id,
        reference_code: appointment.reference_code,
        customer_name: appointment.customer_name,
        appointment_date: appointment.appointment_date,
        start_time: appointment.start_time,
        status: appointment.status,
        moto_brand: appointment.moto_brand,
        moto_model: appointment.moto_model,
        phone: appointment.phone,
        total_estimate: Number(appointment.total_estimate),
        rescheduled_from_appointment_id: appointment.rescheduled_from_appointment_id,
        rescheduled_to_appointment_id: appointment.rescheduled_to_appointment_id,
        serviceName:
          serviceNamesByAppointment.get(appointment.id)?.join(", ") || "Service appointment",
      }));
    },
  });

  const list = data.data ?? [];
  const active = list.filter(
    (appointment) => !["cancelled", "rejected", "no_show"].includes(appointment.status),
  );

  const dashboardBuckets = useMemo(
    () => buildOverviewBuckets(selectedDate, dashboardPeriod, dashboardCustomDateRange),
    [dashboardCustomDateRange, dashboardPeriod, selectedDate],
  );
  const dashboardRange = rangeFromBuckets(dashboardBuckets, selectedDateIso);
  const previousDashboardRange = previousRange(dashboardRange);
  const dashboardAppointments = list.filter((appointment) =>
    isInRange(appointment, dashboardRange),
  );
  const previousDashboardAppointments = list.filter((appointment) =>
    isInRange(appointment, previousDashboardRange),
  );
  const dashboardActive = dashboardAppointments.filter(
    (appointment) => !["cancelled", "rejected", "no_show"].includes(appointment.status),
  );
  const previousDashboardActive = previousDashboardAppointments.filter(
    (appointment) => !["cancelled", "rejected", "no_show"].includes(appointment.status),
  );
  const dashboardSchedule = dashboardActive.slice(0, 5);
  const upcoming = active
    .filter(
      (appointment) =>
        appointment.appointment_date > dashboardRange.to &&
        appointment.status !== "rescheduled" &&
        !appointment.rescheduled_to_appointment_id,
    )
    .slice(0, 5);
  const dashboardPending = dashboardActive.filter(
    (appointment) => appointment.status === "pending",
  );
  const previousDashboardPending = previousDashboardActive.filter(
    (appointment) => appointment.status === "pending",
  );
  const dashboardCustomers = new Set(dashboardActive.map((appointment) => appointment.phone)).size;
  const previousDashboardCustomers = new Set(
    previousDashboardActive.map((appointment) => appointment.phone),
  ).size;
  const dashboardRevenue = dashboardAppointments
    .filter((appointment) => appointment.status === "completed")
    .reduce((sum, appointment) => sum + appointment.total_estimate, 0);
  const previousDashboardRevenue = previousDashboardAppointments
    .filter((appointment) => appointment.status === "completed")
    .reduce((sum, appointment) => sum + appointment.total_estimate, 0);

  const chartBuckets = useMemo(
    () => buildOverviewBuckets(selectedDate, chartPeriod, chartCustomDateRange),
    [chartCustomDateRange, chartPeriod, selectedDate],
  );
  const appointmentOverview = chartBuckets.map((bucket) => {
    const dayAppointments = list.filter(
      (appointment) =>
        appointment.appointment_date >= bucket.from && appointment.appointment_date <= bucket.to,
    );
    return {
      day: bucket.label,
      completed: dayAppointments.filter((appointment) => appointment.status === "completed").length,
      confirmed: dayAppointments.filter((appointment) => appointment.status === "confirmed").length,
      cancelled: dayAppointments.filter((appointment) =>
        ["cancelled", "rejected", "no_show"].includes(appointment.status),
      ).length,
      in_progress: dayAppointments.filter((appointment) => appointment.status === "in_progress")
        .length,
    };
  });
  const bookingStatuses = [
    {
      key: "pending",
      label: "Pending",
      value: dashboardAppointments.filter((appointment) => appointment.status === "pending").length,
      color: "var(--primary)",
      dotClassName: "bg-primary",
    },
    {
      key: "confirmed",
      label: "Confirmed",
      value: dashboardAppointments.filter((appointment) => appointment.status === "confirmed")
        .length,
      color: "var(--chart-3)",
      dotClassName: "bg-chart-3",
    },
    {
      key: "in_progress",
      label: "In Progress",
      value: dashboardAppointments.filter((appointment) => appointment.status === "in_progress")
        .length,
      color: "var(--chart-4)",
      dotClassName: "bg-chart-4",
    },
    {
      key: "completed",
      label: "Complete",
      value: dashboardAppointments.filter((appointment) => appointment.status === "completed")
        .length,
      color: "var(--chart-2)",
      dotClassName: "bg-chart-2",
    },
    {
      key: "rescheduled",
      label: "Rescheduled",
      value: dashboardAppointments.filter((appointment) => appointment.status === "rescheduled")
        .length,
      color: "var(--chart-5)",
      dotClassName: "bg-chart-5",
    },
    {
      key: "cancelled",
      label: "Canceled",
      value: dashboardAppointments.filter((appointment) =>
        ["cancelled", "rejected"].includes(appointment.status),
      ).length,
      color: "var(--destructive)",
      dotClassName: "bg-destructive",
    },
    {
      key: "no_show",
      label: "No Show",
      value: dashboardAppointments.filter((appointment) => appointment.status === "no_show").length,
      color: "var(--muted-foreground)",
      dotClassName: "bg-muted-foreground",
    },
  ];
  const bookingStatusTotal = bookingStatuses.reduce((sum, status) => sum + status.value, 0);

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
            <Gauge className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="font-display text-2xl tracking-wide uppercase md:text-3xl">Overview</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Here&apos;s what&apos;s happening with your shop
              {dashboardPeriod === "today" ? " today." : " for the selected period."}
            </p>
          </div>
        </div>
        <OverviewPeriodFilter
          period={dashboardPeriod}
          customDateRange={dashboardCustomDateRange}
          onPeriodChange={setDashboardPeriod}
          onCustomDateRangeChange={setDashboardCustomDateRange}
          className="w-full justify-start sm:w-auto"
        />
      </header>

      {data.isError && (
        <Card className="mb-5 border-destructive/40 bg-card/60">
          <CardContent className="p-4 text-sm text-destructive">
            Could not load the dashboard data. Please refresh the page and try again.
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <DashboardStat
          icon={CalendarCheck}
          iconClassName="bg-chart-4/15 text-chart-4"
          label={dashboardPeriod === "today" ? "Today's appointments" : "Appointments"}
          value={String(dashboardActive.length)}
          trend={makeTrend(
            dashboardActive.length,
            previousDashboardActive.length,
            "vs. previous period",
          )}
        />
        <DashboardStat
          icon={CalendarClock}
          iconClassName="bg-emerald-500/15 text-emerald-400"
          label="Pending approval"
          value={String(dashboardPending.length)}
          trend={makeTrend(
            dashboardPending.length,
            previousDashboardPending.length,
            "vs. previous period",
          )}
        />
        <DashboardStat
          icon={Users}
          iconClassName="bg-primary/15 text-primary"
          label="Unique customers"
          value={String(dashboardCustomers)}
          trend={makeTrend(dashboardCustomers, previousDashboardCustomers, "vs. previous period")}
        />
        <DashboardStat
          icon={PhilippinePeso}
          iconClassName="bg-accent/15 text-accent"
          label="Completed revenue"
          value={formatPHP(dashboardRevenue)}
          trend={makeTrend(dashboardRevenue, previousDashboardRevenue, "vs. previous period")}
        />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(19rem,1fr)]">
        <Card className="border-border/70 bg-card/60">
          <CardContent className="p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <BarChart3 className="size-4 text-primary" aria-hidden="true" />
                <h2 className="font-display text-sm tracking-wide uppercase">
                  Appointment overview
                </h2>
              </div>
              <OverviewPeriodFilter
                period={chartPeriod}
                customDateRange={chartCustomDateRange}
                onPeriodChange={setChartPeriod}
                onCustomDateRangeChange={setChartCustomDateRange}
                className="h-8 text-xs"
              />
            </div>
            <ChartContainer config={appointmentChartConfig} className="h-64 w-full aspect-auto">
              <BarChart data={appointmentOverview} margin={{ top: 8, right: 4, left: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="day"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  minTickGap={chartPeriod === "today" || chartPeriod === "7d" ? 0 : 16}
                />
                <YAxis
                  allowDecimals={false}
                  tickLine={false}
                  axisLine={false}
                  width={32}
                  tickCount={6}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                />
                <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
                <Bar
                  dataKey="completed"
                  fill="var(--color-completed)"
                  radius={[3, 3, 0, 0]}
                  minPointSize={2}
                />
                <Bar
                  dataKey="confirmed"
                  fill="var(--color-confirmed)"
                  radius={[3, 3, 0, 0]}
                  minPointSize={2}
                />
                <Bar
                  dataKey="cancelled"
                  fill="var(--color-cancelled)"
                  radius={[3, 3, 0, 0]}
                  minPointSize={2}
                />
                <Bar
                  dataKey="in_progress"
                  fill="var(--color-in_progress)"
                  radius={[3, 3, 0, 0]}
                  minPointSize={2}
                />
              </BarChart>
            </ChartContainer>
            <ChartKey items={appointmentChartConfig} />
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/60">
          <CardContent className="p-4 sm:p-5">
            <div className="flex items-center gap-2">
              <PhilippinePeso className="size-4 text-primary" aria-hidden="true" />
              <h2 className="font-display text-sm tracking-wide uppercase">Appointment status</h2>
            </div>
            <div className="mt-4 grid items-center gap-5 sm:grid-cols-[minmax(10rem,.9fr)_minmax(0,1fr)] xl:grid-cols-[minmax(10rem,.9fr)_minmax(0,1fr)]">
              <div className="relative mx-auto aspect-square w-full max-w-52">
                <ChartContainer
                  config={statusChartConfig}
                  className="absolute inset-0 h-full w-full aspect-auto"
                >
                  <PieChart>
                    <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
                    <Pie
                      data={bookingStatuses}
                      dataKey="value"
                      nameKey="label"
                      innerRadius="58%"
                      outerRadius="84%"
                      paddingAngle={2}
                      strokeWidth={0}
                    >
                      {bookingStatuses.map((status) => (
                        <Cell key={status.key} fill={status.color} />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
                <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
                  <div>
                    <p className="font-display text-3xl text-foreground">{bookingStatusTotal}</p>
                    <p className="text-xs text-muted-foreground uppercase">Total</p>
                  </div>
                </div>
              </div>
              <ul className="space-y-3 text-sm">
                {bookingStatuses.map((status) => (
                  <li key={status.key} className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className={cn("size-2.5 shrink-0 rounded-full", status.dotClassName)} />
                      <span className="truncate">{status.label}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-muted-foreground">
                      <strong className="font-medium text-foreground">{status.value}</strong>
                      <span className="w-10 text-right text-xs">
                        {bookingStatusTotal
                          ? `${((status.value / bookingStatusTotal) * 100).toFixed(1)}%`
                          : "0.0%"}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)]">
        <SchedulePanel
          title={dashboardPeriod === "today" ? "Today's schedule" : "Appointments"}
          empty="No appointments found for this period."
          rows={dashboardSchedule}
          showDate={dashboardPeriod !== "today"}
        />
        <SchedulePanel
          title="Upcoming appointments"
          empty="No upcoming appointments yet."
          rows={upcoming}
          upcoming
        />
      </div>
    </div>
  );
}

function DashboardStat({
  icon: Icon,
  iconClassName,
  label,
  value,
  trend,
}: {
  icon: LucideIcon;
  iconClassName: string;
  label: string;
  value: string;
  trend: Trend;
}) {
  return (
    <Card className="border-border/70 bg-card/60">
      <CardContent className="p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <span
            className={cn("grid size-10 shrink-0 place-items-center rounded-lg", iconClassName)}
          >
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <p className="text-xs tracking-wider text-muted-foreground uppercase">{label}</p>
        </div>
        <div className="mt-3 flex items-end justify-between gap-3">
          <div>
            <p className="font-display text-2xl text-foreground">{value}</p>
            <p
              className={cn(
                "mt-2 flex items-center gap-1 text-xs font-medium",
                trend.direction === "up" && "text-emerald-500",
                trend.direction === "down" && "text-destructive",
                trend.direction === "flat" && "text-muted-foreground",
              )}
            >
              {trend.direction === "up" && <TrendingUp className="size-3.5" aria-hidden="true" />}
              {trend.direction === "down" && (
                <TrendingDown className="size-3.5" aria-hidden="true" />
              )}
              {trend.label}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{trend.description}</p>
          </div>
          <TrendLine direction={trend.direction} />
        </div>
      </CardContent>
    </Card>
  );
}

function ChartKey({ items }: { items: ChartConfig }) {
  return (
    <div className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
      {Object.entries(items).map(([key, item]) => (
        <span key={key} className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full" style={{ backgroundColor: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function OverviewPeriodFilter({
  period,
  customDateRange,
  onPeriodChange,
  onCustomDateRangeChange,
  className,
}: {
  period: OverviewPeriod;
  customDateRange: DateRange | undefined;
  onPeriodChange: (period: OverviewPeriod) => void;
  onCustomDateRangeChange: (range: DateRange | undefined) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [isPickingCustomRange, setIsPickingCustomRange] = useState(false);
  const [draftCustomDateRange, setDraftCustomDateRange] = useState<DateRange>();

  const selectPeriod = (nextPeriod: Exclude<OverviewPeriod, "custom">) => {
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
          {overviewPeriodLabel(period, customDateRange)}
          <ChevronDown className="size-3.5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
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
              Overview period
            </p>
            <OverviewPeriodOption
              active={period === "today"}
              label="Today"
              onClick={() => selectPeriod("today")}
            />
            <OverviewPeriodOption
              active={period === "7d"}
              label="Last 7 days"
              onClick={() => selectPeriod("7d")}
            />
            <OverviewPeriodOption
              active={period === "month"}
              label="This month"
              onClick={() => selectPeriod("month")}
            />
            <OverviewPeriodOption
              active={period === "year"}
              label="This year"
              onClick={() => selectPeriod("year")}
            />
            <OverviewPeriodOption
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

function OverviewPeriodOption({
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

function SchedulePanel({
  title,
  rows,
  empty,
  upcoming = false,
  showDate = false,
}: {
  title: string;
  rows: DashboardAppointment[];
  empty: string;
  upcoming?: boolean;
  showDate?: boolean;
}) {
  return (
    <Card className="border-border/70 bg-card/60">
      <CardContent className="p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <CalendarCheck className="size-4 text-primary" aria-hidden="true" />
            <h2 className="font-display text-sm tracking-wide uppercase">{title}</h2>
          </div>
          <Link
            to="/admin/appointments"
            className="text-xs font-medium text-primary hover:underline"
          >
            View all
          </Link>
        </div>
        {rows.length === 0 ? (
          <p className="py-7 text-center text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {rows.map((appointment) => (
              <li
                key={appointment.id}
                className={cn(
                  "grid items-center gap-x-2 gap-y-3 py-3 first:pt-0 last:pb-0",
                  upcoming
                    ? "grid-cols-[4px_minmax(0,1fr)_auto_auto] sm:grid-cols-[4px_minmax(9rem,.9fr)_minmax(0,1fr)_auto_auto]"
                    : showDate
                      ? "grid-cols-[4px_minmax(6.5rem,.75fr)_minmax(0,1fr)_auto] sm:grid-cols-[4px_minmax(8rem,.85fr)_minmax(5.5rem,.8fr)_minmax(6rem,1fr)_auto]"
                      : "grid-cols-[4px_minmax(3.5rem,.55fr)_minmax(0,1fr)_auto] sm:grid-cols-[4px_4.5rem_minmax(5.5rem,.8fr)_minmax(6rem,1fr)_auto]",
                )}
              >
                <span
                  className={cn(
                    "h-8 w-1 shrink-0 rounded-full",
                    scheduleStripe(appointment.status),
                  )}
                  aria-hidden="true"
                />
                {upcoming ? (
                  <>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">
                        {format(isoDateToCalendarDate(appointment.appointment_date), "MMM d, yyyy")}{" "}
                        &middot; {formatTime(String(appointment.start_time).slice(0, 5))}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground sm:hidden">
                        {appointment.customer_name} &middot; {appointment.reference_code}
                      </p>
                    </div>
                    <p className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">
                      {appointment.customer_name} &middot; {appointment.reference_code}
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-medium">
                      {showDate && (
                        <>
                          {format(isoDateToCalendarDate(appointment.appointment_date), "MMM d")}{" "}
                          &middot;{" "}
                        </>
                      )}
                      {formatTime(String(appointment.start_time).slice(0, 5))}
                    </p>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{appointment.customer_name}</p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground sm:hidden">
                        {appointment.serviceName}
                      </p>
                    </div>
                    <div className="hidden min-w-0 sm:block">
                      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">
                        Service
                      </p>
                      <p className="mt-0.5 truncate text-xs text-foreground">
                        {appointment.serviceName}
                      </p>
                    </div>
                  </>
                )}
                <Badge
                  variant="outline"
                  className={cn("shrink-0 text-[10px] uppercase", statusTone(appointment.status))}
                >
                  {statusLabel(appointment.status)}
                </Badge>
                {upcoming && (
                  <Link
                    to="/admin/appointments"
                    search={{ appointmentId: appointment.id }}
                    className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`View appointment ${appointment.reference_code}`}
                  >
                    <ChevronRight className="size-4" aria-hidden="true" />
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function rangeFromBuckets(buckets: { from: string; to: string }[], fallback: string): IsoDateRange {
  return {
    from: buckets[0]?.from ?? fallback,
    to: buckets.at(-1)?.to ?? fallback,
  };
}

function previousRange(range: IsoDateRange): IsoDateRange {
  const from = Date.parse(`${range.from}T00:00:00Z`);
  const to = Date.parse(`${range.to}T00:00:00Z`);
  const days = Math.max(1, Math.round((to - from) / 86_400_000) + 1);
  return {
    from: addDays(range.from, -days),
    to: addDays(range.to, -days),
  };
}

function isInRange(appointment: DashboardAppointment, range: IsoDateRange) {
  return appointment.appointment_date >= range.from && appointment.appointment_date <= range.to;
}

function overviewPeriodLabel(period: OverviewPeriod, customRange?: DateRange) {
  if (period === "today") return "Today";
  if (period === "7d") return "Last 7 days";
  if (period === "month") return "This month";
  if (period === "year") return "This year";
  if (!customRange?.from || !customRange.to) return "Custom date range";

  return `${format(customRange.from, "MMM d")} – ${format(customRange.to, "MMM d, yyyy")}`;
}

function buildOverviewBuckets(date: Date, period: OverviewPeriod, customRange?: DateRange) {
  const year = date.getFullYear();
  const month = date.getMonth();

  if (period === "year") {
    return Array.from({ length: 12 }, (_, index) => {
      const monthStart = new Date(year, index, 1, 12);
      const monthEnd = new Date(year, index + 1, 0, 12);
      return {
        label: format(monthStart, "MMM"),
        from: format(monthStart, "yyyy-MM-dd"),
        to: format(monthEnd, "yyyy-MM-dd"),
      };
    });
  }

  if (period === "month") {
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    return Array.from({ length: daysInMonth }, (_, index) => {
      const day = new Date(year, month, index + 1, 12);
      const value = format(day, "yyyy-MM-dd");
      return { label: format(day, "d"), from: value, to: value };
    });
  }

  const today = format(date, "yyyy-MM-dd");
  if (period === "today") {
    return [{ label: format(date, "MMM d"), from: today, to: today }];
  }

  if (period === "custom" && customRange?.from && customRange.to) {
    const range = calendarRangeToIso(customRange);
    if (range) return buildDailyBuckets(range.from, range.to);
  }

  return Array.from({ length: 7 }, (_, index) => {
    const day = addDays(today, index - 6);
    return { label: format(isoDateToCalendarDate(day), "MMM d"), from: day, to: day };
  });
}

function buildDailyBuckets(from: string, to: string) {
  const buckets = [] as { label: string; from: string; to: string }[];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    buckets.push({ label: format(isoDateToCalendarDate(day), "MMM d"), from: day, to: day });
  }
  return buckets;
}

function makeTrend(current: number, previous: number, description = "vs. yesterday"): Trend {
  if (previous === 0) {
    if (current === 0) return { direction: "flat", label: "0%", description };
    return { direction: "up", label: "New", description };
  }
  const change = ((current - previous) / Math.abs(previous)) * 100;
  return {
    direction: change > 0 ? "up" : change < 0 ? "down" : "flat",
    label: `${Math.abs(change).toFixed(change >= 10 ? 0 : 1)}%`,
    description,
  };
}

function TrendLine({ direction }: Pick<Trend, "direction">) {
  const path =
    direction === "up"
      ? "M2 25 L13 16 L23 19 L34 8 L46 12 L58 2"
      : direction === "down"
        ? "M2 4 L13 13 L23 10 L34 21 L46 17 L58 28"
        : "M2 16 L13 16 L23 15 L34 16 L46 15 L58 16";
  return (
    <svg
      viewBox="0 0 60 30"
      className={cn(
        "h-8 w-14 shrink-0",
        direction === "up" && "text-emerald-500",
        direction === "down" && "text-destructive",
        direction === "flat" && "text-muted-foreground",
      )}
      aria-hidden="true"
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function scheduleStripe(status: string) {
  if (status === "completed") return "bg-chart-4";
  if (status === "pending") return "bg-primary";
  if (status === "in_progress") return "bg-accent";
  return "bg-emerald-500";
}
