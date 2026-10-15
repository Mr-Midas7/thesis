import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  CalendarDays,
  ChevronRight,
  CircleAlert,
  History,
  Loader2,
  Phone,
  Search,
  Users,
  X,
} from "lucide-react";
import { useDeferredValue, useEffect, useState } from "react";
import { z } from "zod";

import { PageHeader } from "@/components/admin/page-header";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
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
  formatPHP,
  formatTime,
  manilaNow,
  normalizePhilippineMobile,
  statusLabel,
  statusTone,
  toLocalPhilippineMobile,
} from "@/lib/shop";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/admin/customers")({
  validateSearch: z.object({
    phone: z.string().min(1).optional(),
  }),
  component: CustomersPage,
});

type Customer = {
  customer_name: string;
  phone: string;
  visits: number;
  completed_spend: number | string;
  last_booking: string;
  units: string[];
};

type CustomerPage = { rows: Customer[]; total: number };

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
const VISIBLE_UNIT_COUNT = 2;

function CustomersPage() {
  const search = Route.useSearch();
  const historyPageSize = 10;
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0]);
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyCustomer, setHistoryCustomer] = useState<string | null>(null);
  const deferredTerm = useDeferredValue(term);
  const cleanedSearchTerm = cleanSearchTerm(deferredTerm);
  const customerSearchTerm = normalizePhilippineMobile(cleanedSearchTerm) ?? cleanedSearchTerm;

  const customers = useQuery({
    queryKey: ["customers", { search: customerSearchTerm, page, pageSize }],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_admin_customers_page", {
        p_search: customerSearchTerm || null,
        p_limit: pageSize,
        p_offset: page * pageSize,
      });
      if (error) throw error;
      return data as unknown as CustomerPage;
    },
  });

  const customerHistory = useQuery({
    queryKey: ["customer-history", historyCustomer, historyPage],
    queryFn: async () => {
      if (!historyCustomer) return { rows: [], total: 0 };
      const { data, error, count } = await supabase
        .from("appointments")
        .select(
          "id,reference_code,customer_name,appointment_date,start_time,status,total_estimate,moto_brand,moto_model,plate_number,is_archived",
          { count: "exact" },
        )
        .eq("phone", normalizePhilippineMobile(historyCustomer) ?? historyCustomer)
        .order("appointment_date", { ascending: false })
        .order("start_time", { ascending: false })
        .range(historyPage * historyPageSize, historyPage * historyPageSize + historyPageSize - 1);
      if (error) throw error;
      return { rows: data ?? [], total: count ?? 0 };
    },
    enabled: !!historyCustomer,
  });

  useEffect(() => {
    setPage(0);
  }, [term]);

  useEffect(() => {
    if (!search.phone) return;
    setTerm(normalizePhilippineMobile(search.phone) ?? search.phone);
    setPage(0);
    setHistoryCustomer(normalizePhilippineMobile(search.phone) ?? search.phone);
    setHistoryPage(0);
  }, [search.phone]);

  const rows = customers.data?.rows ?? [];
  const total = customers.data?.total ?? 0;
  const today = manilaNow().date;
  const searching = Boolean(term.trim());

  function openHistory(customer: Customer) {
    setHistoryCustomer(customer.phone);
    setHistoryPage(0);
  }

  const historyButton = (customer: Customer) => (
    <Button
      size="sm"
      variant="outline"
      aria-label={`View ${customer.customer_name}'s appointment history`}
      onClick={() => openHistory(customer)}
    >
      <History /> View history
    </Button>
  );

  return (
    <div className="mx-auto w-full max-w-7xl">
      <PageHeader
        title="Customer List"
        description="Everyone who has booked with the shop. Search by name or mobile number to find a customer and review their bookings."
      />

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="relative min-w-0 lg:w-80">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Search by name or mobile number"
            aria-label="Search customers by name or mobile number"
            className="pr-9 pl-9 [&::-webkit-search-cancel-button]:hidden"
          />
          {searching && (
            <span className="absolute top-1/2 right-2 -translate-y-1/2">
              {customers.isFetching ? (
                <Loader2
                  className="mr-1 size-4 animate-spin text-muted-foreground"
                  aria-label="Searching"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setTerm("")}
                  aria-label="Clear search"
                  className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <X className="size-4" aria-hidden="true" />
                </button>
              )}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground lg:justify-end">
          <span className="inline-flex items-center gap-1.5">
            <Users className="size-4" aria-hidden="true" />
            {customers.data
              ? `${total} ${total === 1 ? "customer" : "customers"}${searching ? " found" : ""}`
              : "Loading customers…"}
          </span>
          <label className="inline-flex items-center gap-2">
            <span>Rows per page</span>
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                setPageSize(Number(value));
                setPage(0);
              }}
            >
              <SelectTrigger aria-label="Rows per page" className="h-9 w-20 md:h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
      </div>

      <Card className="overflow-hidden border-border/70 bg-card/60">
        <CardContent className="p-0">
          {rows.length > 0 && (
            <>
              {/* Phones and tablets: one card per customer, so nothing scrolls
                  sideways next to the admin sidebar. */}
              <ul className="divide-y divide-border/70 lg:hidden">
                {rows.map((customer) => (
                  <li key={customer.phone} className="space-y-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <CustomerIdentity customer={customer} />
                      <div className="shrink-0 text-right">
                        <p
                          className={cn(
                            "font-medium tabular-nums",
                            Number(customer.completed_spend) > 0
                              ? "text-primary"
                              : "text-muted-foreground",
                          )}
                        >
                          {formatPHP(customer.completed_spend)}
                        </p>
                        <p className="text-xs text-muted-foreground">completed spend</p>
                      </div>
                    </div>
                    <UnitList units={customer.units} />
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        {customer.visits} {customer.visits === 1 ? "booking" : "bookings"} · Last
                        booking <LastBooking date={customer.last_booking} today={today} />
                      </p>
                      {historyButton(customer)}
                    </div>
                  </li>
                ))}
              </ul>

              {/* Laptops and desktops: a compact table. */}
              <Table className="hidden w-full table-fixed lg:table">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Customer</TableHead>
                    <TableHead className="w-52">Motorcycles</TableHead>
                    <TableHead className="hidden w-24 text-center xl:table-cell">
                      Bookings
                    </TableHead>
                    <TableHead className="w-32 text-right">Completed spend</TableHead>
                    <TableHead className="hidden w-36 xl:table-cell">Last booking</TableHead>
                    <TableHead className="w-40 pr-5 text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((customer) => (
                    <TableRow key={customer.phone}>
                      <TableCell className="pl-5">
                        <CustomerIdentity customer={customer} />
                        {/* Bookings and last booking get their own columns from xl. */}
                        <p className="mt-1 pl-12 text-xs text-muted-foreground xl:hidden">
                          {customer.visits} {customer.visits === 1 ? "booking" : "bookings"} · Last{" "}
                          <LastBooking date={customer.last_booking} today={today} />
                        </p>
                      </TableCell>
                      <TableCell>
                        <UnitList units={customer.units} limit={VISIBLE_UNIT_COUNT} />
                      </TableCell>
                      <TableCell className="hidden text-center xl:table-cell">
                        <span className="inline-flex min-w-8 justify-center rounded-full bg-muted px-2 py-0.5 text-sm font-medium tabular-nums">
                          {customer.visits}
                        </span>
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-medium tabular-nums",
                          Number(customer.completed_spend) > 0
                            ? "text-primary"
                            : "text-muted-foreground",
                        )}
                      >
                        {formatPHP(customer.completed_spend)}
                      </TableCell>
                      <TableCell className="hidden text-sm xl:table-cell">
                        <LastBooking date={customer.last_booking} today={today} stacked />
                      </TableCell>
                      <TableCell className="pr-5 text-right">{historyButton(customer)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}

          {customers.isLoading && <CustomerListSkeleton />}
          {customers.isError && (
            <div className="px-4 py-10 text-center">
              <p className="inline-flex items-center gap-2 text-sm text-destructive">
                <CircleAlert className="size-4" aria-hidden="true" /> Could not load customers.
                Please try again.
              </p>
              <div className="mt-3">
                <Button size="sm" variant="outline" onClick={() => void customers.refetch()}>
                  Try again
                </Button>
              </div>
            </div>
          )}
          {customers.isSuccess && rows.length === 0 && (
            <div className="px-4 py-12 text-center">
              <Users className="mx-auto size-8 text-muted-foreground/60" aria-hidden="true" />
              <p className="mt-3 text-sm font-medium">
                {searching ? "No customers match your search." : "No customers found."}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {searching
                  ? "Check the spelling or try a mobile number such as 09171234567."
                  : "Customers appear here after their first booking."}
              </p>
              {searching && (
                <Button size="sm" variant="outline" className="mt-4" onClick={() => setTerm("")}>
                  Clear search
                </Button>
              )}
            </div>
          )}
          <PaginationControls
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>

      <CustomerHistoryDialog
        phone={historyCustomer}
        customer={rows.find((customer) => customer.phone === historyCustomer) ?? null}
        history={customerHistory.data}
        loading={customerHistory.isLoading}
        error={customerHistory.isError}
        onRetry={() => void customerHistory.refetch()}
        page={historyPage}
        pageSize={historyPageSize}
        onPageChange={setHistoryPage}
        onClose={() => setHistoryCustomer(null)}
      />
    </div>
  );
}

type HistoryRow = {
  id: string;
  reference_code: string;
  customer_name: string;
  appointment_date: string;
  start_time: string | null;
  status: string;
  total_estimate: number;
  moto_brand: string | null;
  moto_model: string | null;
  plate_number: string | null;
  is_archived: boolean;
};

function CustomerHistoryDialog({
  phone,
  customer,
  history,
  loading,
  error,
  onRetry,
  page,
  pageSize,
  onPageChange,
  onClose,
}: {
  phone: string | null;
  customer: Customer | null;
  history: { rows: HistoryRow[]; total: number } | undefined;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onClose: () => void;
}) {
  const name = customer?.customer_name ?? history?.rows[0]?.customer_name ?? "Customer";
  const total = history?.total ?? customer?.visits ?? 0;

  return (
    <Dialog open={!!phone} onOpenChange={(open) => !open && onClose()}>
      {/* No bottom padding: the pinned footer below supplies it. */}
      <DialogContent className="grid-cols-[minmax(0,1fr)] pb-0 sm:max-w-3xl sm:pb-0">
        <DialogHeader>
          <p className="text-xs tracking-widest text-muted-foreground uppercase">
            Appointment history
          </p>
          <DialogTitle className="font-display text-2xl break-words uppercase">{name}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 sm:justify-start">
            {phone && (
              <a
                href={`tel:${toLocalPhilippineMobile(phone)}`}
                className="inline-flex items-center gap-1 text-foreground hover:text-primary"
              >
                <Phone className="size-3.5" aria-hidden="true" />
                {toLocalPhilippineMobile(phone)}
              </a>
            )}
            <span>
              {total} {total === 1 ? "booking" : "bookings"}
            </span>
            {customer && (
              <span>
                Completed spend{" "}
                <span className="font-medium text-primary">
                  {formatPHP(customer.completed_spend)}
                </span>
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-2" aria-label="Loading appointment history">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-16 w-full" />
            ))}
          </div>
        ) : error ? (
          <div className="py-8 text-center">
            <p className="inline-flex items-center gap-2 text-sm text-destructive">
              <CircleAlert className="size-4" aria-hidden="true" /> Could not load the appointment
              history.
            </p>
            <div className="mt-3">
              <Button size="sm" variant="outline" onClick={onRetry}>
                Try again
              </Button>
            </div>
          </div>
        ) : history && history.rows.length > 0 ? (
          <ul className="space-y-2">
            {history.rows.map((appointment) => (
              <li
                key={appointment.id}
                className="flex flex-col gap-3 rounded-lg border border-border/70 bg-card/40 p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-start gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                    <CalendarDays className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">
                      {formatShortDate(appointment.appointment_date, { weekday: true })}
                      {appointment.start_time && (
                        <span className="ml-2 font-normal text-muted-foreground">
                          {formatTime(String(appointment.start_time).slice(0, 5))}
                        </span>
                      )}
                    </p>
                    <p className="text-xs break-words text-muted-foreground">
                      <span className="font-medium text-foreground/80">
                        {appointment.reference_code}
                      </span>
                      {" · "}
                      {[appointment.moto_brand, appointment.moto_model].filter(Boolean).join(" ")}
                      {appointment.plate_number ? ` (${appointment.plate_number})` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 pl-12 sm:justify-end sm:pl-0">
                  {appointment.is_archived && (
                    <Badge variant="outline" className="text-[10px] uppercase">
                      Archived
                    </Badge>
                  )}
                  <Badge
                    variant="outline"
                    className={cn("text-[10px] uppercase", statusTone(appointment.status))}
                  >
                    {statusLabel(appointment.status)}
                  </Badge>
                  <span className="text-sm font-medium text-primary tabular-nums">
                    {formatPHP(appointment.total_estimate)}
                  </span>
                  {!appointment.is_archived && (
                    <Button asChild size="sm" variant="ghost" className="h-8 px-2 md:h-8">
                      <Link
                        to="/admin/appointments"
                        search={{ appointmentId: appointment.id }}
                        aria-label={`Open appointment ${appointment.reference_code}`}
                      >
                        Open <ChevronRight aria-hidden="true" />
                      </Link>
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">No appointments found.</p>
        )}

        <PaginationControls
          page={page}
          pageSize={pageSize}
          total={history?.total ?? 0}
          onPageChange={onPageChange}
        />

        {/* Pinned to the bottom so it stays visible while a long history scrolls. */}
        <DialogFooter className="sticky bottom-0 -mx-4 gap-2 border-t border-border/70 bg-background px-4 py-3 sm:-mx-6 sm:px-6">
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Close
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CustomerIdentity({ customer }: { customer: Customer }) {
  const phone = toLocalPhilippineMobile(customer.phone);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/15 font-display text-sm text-primary"
      >
        {initials(customer.customer_name)}
      </span>
      <div className="min-w-0">
        <p className="font-medium break-words">{customer.customer_name}</p>
        <a
          href={`tel:${phone}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums hover:text-primary"
          aria-label={`Call ${customer.customer_name} at ${phone}`}
        >
          <Phone className="size-3" aria-hidden="true" />
          {phone}
        </a>
      </div>
    </div>
  );
}

function UnitList({ units, limit }: { units: string[]; limit?: number }) {
  const visible = limit ? units.slice(0, limit) : units;
  const hidden = units.length - visible.length;
  if (units.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Motorcycles">
      {visible.map((unit) => (
        <li
          key={unit}
          className="max-w-full rounded-md border border-border/70 bg-muted/40 px-2 py-0.5 text-xs break-words"
        >
          {unit}
        </li>
      ))}
      {hidden > 0 && (
        <li
          className="rounded-md px-1 py-0.5 text-xs text-muted-foreground"
          title={units.slice(visible.length).join(", ")}
        >
          +{hidden} more
        </li>
      )}
    </ul>
  );
}

function LastBooking({ date, today, stacked }: { date: string; today: string; stacked?: boolean }) {
  const upcoming = date > today;
  return (
    <span className={cn(stacked && "flex flex-col items-start gap-1")}>
      <span className="text-foreground">{formatShortDate(date)}</span>
      {upcoming && (
        <span
          className={cn(
            "rounded-full border border-sky-500/30 bg-sky-500/15 px-1.5 py-px text-[10px] font-medium text-sky-600 uppercase dark:text-sky-400",
            !stacked && "ml-1.5",
          )}
        >
          Upcoming
        </span>
      )}
    </span>
  );
}

function CustomerListSkeleton() {
  return (
    <div className="divide-y divide-border/70" aria-label="Loading customers">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 p-4">
          <Skeleton className="size-9 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-40 max-w-full" />
            <Skeleton className="h-3 w-28 max-w-full" />
          </div>
          <Skeleton className="hidden h-8 w-28 sm:block" />
        </div>
      ))}
    </div>
  );
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase() || "?";
}

/** Formats a YYYY-MM-DD date without shifting it across time zones. */
function formatShortDate(iso: string, options: { weekday?: boolean } = {}) {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).toLocaleDateString("en-PH", {
    ...(options.weekday ? { weekday: "short" } : {}),
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function cleanSearchTerm(value: string) {
  return value
    .trim()
    .replace(/[,%_()]/g, " ")
    .replace(/\s+/g, " ");
}
