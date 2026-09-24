import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { CalendarDays } from "lucide-react";
import { useDeferredValue, useEffect, useState } from "react";
import { z } from "zod";

import { PageHeader } from "@/components/admin/page-header";
import { ActiveFilterChips } from "@/components/admin/active-filter-chips";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
  formatDateLong,
  formatPHP,
  formatTime,
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

function CustomersPage() {
  const search = Route.useSearch();
  const pageSize = 10;
  const historyPageSize = 10;
  const [term, setTerm] = useState("");
  const [page, setPage] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyCustomer, setHistoryCustomer] = useState<string | null>(null);
  const deferredTerm = useDeferredValue(term);
  const cleanedSearchTerm = cleanSearchTerm(deferredTerm);
  const customerSearchTerm = normalizePhilippineMobile(cleanedSearchTerm) ?? cleanedSearchTerm;

  const customers = useQuery({
    queryKey: ["customers", { search: customerSearchTerm, page }],
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
          "id,customer_name,appointment_date,start_time,status,total_estimate,moto_brand,moto_model,plate_number,is_archived",
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

  return (
    <div>
      <PageHeader title="Customer List" description="Everyone who has booked with the shop." />
      <Input
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        placeholder="Search name or number"
        className="mb-4 max-w-xs"
      />
      <ActiveFilterChips
        filters={
          term.trim() ? [{ label: "Search", value: term.trim(), onClear: () => setTerm("") }] : []
        }
        onReset={() => {
          setTerm("");
          setPage(0);
        }}
      />
      <Card className="border-border/70 bg-card/60">
        <CardContent className="overflow-x-auto p-0">
          <Table className="admin-data-table">
            <TableHeader>
              <TableRow>
                <TableHead className="text-left">Customer</TableHead>
                <TableHead className="text-left">Contact</TableHead>
                <TableHead className="text-left">Units</TableHead>
                <TableHead className="text-center">Bookings</TableHead>
                <TableHead className="text-right">Completed spend</TableHead>
                <TableHead className="text-left">Last booking</TableHead>
                <TableHead className="text-center">History</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((customer) => (
                <TableRow key={customer.phone}>
                  <TableCell data-label="Customer" className="text-sm">
                    {customer.customer_name}
                  </TableCell>
                  <TableCell data-label="Contact" className="text-xs">
                    {toLocalPhilippineMobile(customer.phone)}
                  </TableCell>
                  <TableCell data-label="Units" className="max-w-72 text-xs">
                    {customer.units.join(", ")}
                  </TableCell>
                  <TableCell data-label="Bookings" className="text-center text-sm">
                    {customer.visits}
                  </TableCell>
                  <TableCell
                    data-label="Completed spend"
                    className="text-right text-sm text-primary"
                  >
                    {formatPHP(customer.completed_spend)}
                  </TableCell>
                  <TableCell data-label="Last booking" className="text-xs">
                    {formatDateLong(customer.last_booking)}
                  </TableCell>
                  <TableCell data-label="History" className="text-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`View ${customer.customer_name}'s appointment history`}
                      onClick={() => {
                        setHistoryCustomer(customer.phone);
                        setHistoryPage(0);
                      }}
                    >
                      View
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {!customers.isLoading && rows.length === 0 && (
            <p className="p-8 text-center text-sm text-muted-foreground">No customers found.</p>
          )}
          {customers.isError && (
            <p className="p-8 text-center text-sm text-destructive">
              Could not load customers. Please try again.
            </p>
          )}
          <PaginationControls
            page={page}
            pageSize={pageSize}
            total={customers.data?.total ?? 0}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>

      <Dialog open={!!historyCustomer} onOpenChange={(open) => !open && setHistoryCustomer(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="font-display uppercase">Appointment History</DialogTitle>
          </DialogHeader>
          <div className="space-y-1">
            {customerHistory.data?.rows.map((appointment) => (
              <div
                key={appointment.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/50 p-3 text-sm"
              >
                <div className="flex items-center gap-3">
                  <CalendarDays className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <span className="font-medium">
                      {formatDateLong(appointment.appointment_date)}
                    </span>
                    {appointment.start_time && (
                      <span className="ml-2 text-muted-foreground">
                        {formatTime(String(appointment.start_time).slice(0, 5))}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-xs text-muted-foreground">
                    {appointment.moto_brand} {appointment.moto_model}
                  </span>
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
                  <span className="text-sm text-primary">
                    {formatPHP(appointment.total_estimate)}
                  </span>
                </div>
              </div>
            ))}
            {!customerHistory.isLoading && customerHistory.data?.rows.length === 0 && (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No appointments found.
              </p>
            )}
          </div>
          <PaginationControls
            page={historyPage}
            pageSize={historyPageSize}
            total={customerHistory.data?.total ?? 0}
            onPageChange={setHistoryPage}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function cleanSearchTerm(value: string) {
  return value
    .trim()
    .replace(/[,%_()]/g, " ")
    .replace(/\s+/g, " ");
}
