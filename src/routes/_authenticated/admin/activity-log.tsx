import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { format } from "date-fns";
import { CalendarRange, ChevronDown, Download, FileText, RefreshCw, Search } from "lucide-react";
import type { DateRange } from "react-day-picker";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "@/components/admin/page-header";
import { ActiveFilterChips } from "@/components/admin/active-filter-chips";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { supabase } from "@/integrations/supabase/client";
import {
  formatBusinessTimestamp,
  getShopLogoDataUrl,
  SHOP_EXPORT_NAME,
  SHOP_OWNER_NAME,
} from "@/lib/export-branding";
import { recordAdminActivityEvent } from "@/lib/admin-activity";
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

type ExportFormat = "pdf" | "docx";
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
  const [pendingExport, setPendingExport] = useState<ExportFormat | null>(null);
  const deferredSearch = useDeferredValue(search);
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
  const activeFilters = [
    ...(search.trim()
      ? [{ label: "Search", value: search.trim(), onClear: () => setSearch("") }]
      : []),

    ...(action !== "all"
      ? [{ label: "Action", value: action, onClear: () => setAction("all") }]
      : []),
    ...(resource !== "all"
      ? [{ label: "Category", value: resource, onClear: () => setResource("all") }]
      : []),
    ...(activityPeriod !== "all"
      ? [
          {
            label: "Activity date",
            value: activityPeriodLabel(activityPeriod, activityCustomDateRange),
            onClear: () => {
              setActivityPeriod("all");
              setActivityCustomDateRange(undefined);
            },
          },
        ]
      : []),
  ];
  const filterDescription = useMemo(() => {
    if (!hasFilters) return "Showing 10 records per page from the last 50 days.";
    return `Showing page ${page + 1} of ${logs.data?.total ?? 0} matching records from the last 50 days.`;
  }, [hasFilters, logs.data?.total, page]);

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

  async function exportPdf() {
    const [{ jsPDF }, { default: autoTable }] = await Promise.all([
      import("jspdf"),
      import("jspdf-autotable"),
    ]);
    const doc = new jsPDF({ orientation: "landscape" });
    const logoDataUrl = await getShopLogoDataUrl();
    const pageWidth = doc.internal.pageSize.getWidth();
    doc.setFontSize(16);
    const logoSize = 24;
    const brandGap = 6;
    const brandStartX = (pageWidth - logoSize - brandGap - doc.getTextWidth(SHOP_EXPORT_NAME)) / 2;
    doc.addImage(logoDataUrl, "PNG", brandStartX, 10, logoSize, logoSize);
    doc.text(SHOP_EXPORT_NAME, brandStartX + logoSize + brandGap, 26);
    doc.setFontSize(11);
    doc.text("ADMIN ACTIVITY LOG", 14, 54);
    doc.setFontSize(9);
    doc.text(`Generated: ${formatBusinessTimestamp()}`, 14, 60);
    const scopeLines = doc.splitTextToSize(`Scope: ${filterDescription}`, pageWidth - 28);
    doc.text(scopeLines, 14, 66);
    const tableStartY = 66 + scopeLines.length * 5 + 4;

    autoTable(doc, {
      startY: tableStartY,
      head: [
        [
          "Date",
          "Time",
          "User",
          "Action",
          "Category",
          "Record",
          "Record ID",
          "IP address",
          "Changed fields",
        ],
      ],
      body: exportRows(rows),
      theme: "grid",
      margin: { bottom: 48 },
      styles: { fontSize: 7 },
      headStyles: { fillColor: [220, 220, 220], textColor: [0, 0, 0] },
    });

    const pageHeight = doc.internal.pageSize.getHeight();
    const signatureX = pageWidth - 78;
    const signatureLineY = pageHeight - 29;
    doc.setPage(doc.getNumberOfPages());
    doc.setDrawColor(80);
    doc.line(signatureX, signatureLineY, pageWidth - 14, signatureLineY);
    doc.setFontSize(10);
    doc.text(SHOP_OWNER_NAME, pageWidth - 46, signatureLineY + 6, { align: "center" });
    doc.setFontSize(8);
    doc.text("Shop Owner / Authorized Signatory", pageWidth - 46, signatureLineY + 11, {
      align: "center",
    });
    doc.text("Signature over printed name", pageWidth - 46, signatureLineY - 3, {
      align: "center",
    });
    doc.save(`fake-rider-activity-log-${fileDate()}.pdf`);
    toast.success("Activity log PDF exported.");
  }

  async function exportDocx() {
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
    const logoDataUrl = await getShopLogoDataUrl();
    const cell = (text: string, header = false) =>
      new TableCell({
        ...(header ? { shading: { fill: "E5E7EB" } } : {}),
        children: [
          new Paragraph({
            children: [new TextRun({ text, bold: header, size: header ? 18 : 16 })],
          }),
        ],
      });
    const headers = [
      "Date",
      "Time",
      "User",
      "Action",
      "Category",
      "Record",
      "Record ID",
      "IP address",
      "Changed fields",
    ];
    const table = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: "555555" },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: "555555" },
        left: { style: BorderStyle.SINGLE, size: 4, color: "555555" },
        right: { style: BorderStyle.SINGLE, size: 4, color: "555555" },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "AAAAAA" },
        insideVertical: { style: BorderStyle.SINGLE, size: 2, color: "AAAAAA" },
      },
      rows: [
        new TableRow({ tableHeader: true, children: headers.map((header) => cell(header, true)) }),
        ...exportRows(rows).map(
          (row) => new TableRow({ children: row.map((value) => cell(value)) }),
        ),
      ],
    });
    const document = new Document({
      sections: [
        {
          properties: {
            page: {
              size: { width: 16840, height: 11900, orientation: PageOrientation.LANDSCAPE },
              margin: { top: 720, bottom: 720, left: 720, right: 720 },
            },
          },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { after: 180 },
              children: [
                new ImageRun({
                  data: dataUrlToBytes(logoDataUrl),
                  type: "png",
                  transformation: { width: 36, height: 20 },
                }),
                new TextRun({ text: `  ${SHOP_EXPORT_NAME}`, bold: true, size: 30 }),
              ],
            }),
            new Paragraph({
              children: [new TextRun({ text: "ADMIN ACTIVITY LOG", bold: true, size: 24 })],
              spacing: { after: 80 },
            }),
            new Paragraph({
              text: `Generated: ${formatBusinessTimestamp()}`,
              spacing: { after: 50 },
            }),
            new Paragraph({ text: `Scope: ${filterDescription}`, spacing: { after: 180 } }),
            table,
            new Paragraph({ text: "", spacing: { before: 520 } }),
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new TextRun({ text: "Signature over printed name", size: 16 })],
            }),
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new TextRun({ text: "____________________________", size: 20 })],
            }),
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new TextRun({ text: SHOP_OWNER_NAME, bold: true, size: 18 })],
            }),
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new TextRun({ text: "Shop Owner / Authorized Signatory", size: 16 })],
            }),
          ],
        },
      ],
    });
    downloadFile(await Packer.toBlob(document), `fake-rider-activity-log-${fileDate()}.docx`);
    toast.success("Activity log DOCX exported.");
  }

  async function confirmExport() {
    try {
      if (pendingExport === "pdf") await exportPdf();
      if (pendingExport === "docx") await exportDocx();
      if (pendingExport) {
        await recordAdminActivityEvent({
          action: "exported",
          resourceType: "Activity Log",
          targetLabel: `${pendingExport.toUpperCase()} export`,
          summary: `Exported ${rows.length} activity ${rows.length === 1 ? "record" : "records"} as ${pendingExport.toUpperCase()}.`,
          changedFields: ["export_format"],
        });
      }
    } catch {
      toast.error("Could not create the activity log export. Please try again.");
    } finally {
      setPendingExport(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Activity Log"
        description="Admin changes and sign-in events are retained for 50 days with record IDs and request IP addresses."
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={refresh} disabled={logs.isFetching}>
              <RefreshCw className={logs.isFetching ? "animate-spin" : ""} /> Refresh
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" disabled={rows.length === 0}>
                  <Download /> Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setPendingExport("pdf")}>
                  <FileText /> Export PDF table
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPendingExport("docx")}>
                  <FileText /> Export DOCX table
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />

      <Card className="mb-6 border-border/70 bg-card/60">
        <CardContent className="grid gap-4 p-5 lg:grid-cols-[minmax(15rem,2fr)_minmax(9rem,1fr)_minmax(10rem,1.1fr)_minmax(11rem,1.25fr)]">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="activity-search">Search</Label>
            <div className="relative">
              <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="activity-search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-9"
                placeholder="Search activity, record, user, or IP address"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Action</Label>
            <Select value={action} onValueChange={setAction}>
              <SelectTrigger>
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
          </div>
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select value={resource} onValueChange={setResource}>
              <SelectTrigger>
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
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label>Activity date</Label>
            <ActivityPeriodFilter
              period={activityPeriod}
              customDateRange={activityCustomDateRange}
              onPeriodChange={setActivityPeriod}
              onCustomDateRangeChange={setActivityCustomDateRange}
              className="w-full justify-between"
            />
          </div>
        </CardContent>
      </Card>
      <ActiveFilterChips filters={activeFilters} onReset={clearFilters} />

      <Card className="border-border/70 bg-card/60">
        <CardContent className="overflow-x-auto p-0">
          <div className="border-b border-border px-5 py-3 text-sm text-muted-foreground">
            {filterDescription}
          </div>
          <Table className="admin-data-table">
            <TableHeader>
              <TableRow>
                <TableHead>Date & time</TableHead>
                <TableHead>User</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Record ID</TableHead>
                <TableHead>IP address</TableHead>
                <TableHead>Changed fields</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell data-label="Date & time" className="whitespace-nowrap text-sm">
                    {formatActivityDate(row.activity_date)}
                    <span className="block text-xs text-muted-foreground">
                      {formatActivityTime(row.activity_time)}
                    </span>
                  </TableCell>
                  <TableCell data-label="User" className="text-sm">
                    {row.actor_email ?? "Unknown admin"}
                  </TableCell>
                  <TableCell data-label="Action">
                    <span className="block text-sm">{row.summary}</span>
                    <span className="text-xs text-muted-foreground">{row.target_label}</span>
                  </TableCell>
                  <TableCell data-label="Category">
                    <Badge variant="outline" className="capitalize">
                      {row.resource_type}
                    </Badge>
                  </TableCell>
                  <TableCell
                    data-label="Record ID"
                    className="max-w-52 break-all font-mono text-xs"
                  >
                    {row.record_id ?? "—"}
                  </TableCell>
                  <TableCell data-label="IP address" className="font-mono text-xs">
                    {row.ip_address ?? "Unavailable"}
                  </TableCell>
                  <TableCell data-label="Changed fields" className="min-w-44">
                    {row.changed_fields.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {row.changed_fields.map((field) => (
                          <Badge key={field} variant="secondary" className="font-normal">
                            {field.replace(/_/g, " ")}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {!logs.isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={7}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No activity records match these filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {logs.isLoading && (
            <p className="p-8 text-center text-sm text-muted-foreground">Loading activity…</p>
          )}
          {logs.isError && (
            <p className="p-8 text-center text-sm text-destructive">
              Could not load the activity log. Refresh and try again.
            </p>
          )}
          <PaginationControls
            page={page}
            pageSize={pageSize}
            total={logs.data?.total ?? 0}
            onPageChange={setPage}
          />
        </CardContent>
      </Card>

      <AlertDialog
        open={pendingExport !== null}
        onOpenChange={(open) => {
          if (!open) setPendingExport(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm activity log export</AlertDialogTitle>
            <AlertDialogDescription>
              Export {rows.length} {rows.length === 1 ? "activity record" : "activity records"} as a{" "}
              {pendingExport?.toUpperCase()} table?
            </AlertDialogDescription>
          </AlertDialogHeader>
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

  const date = dateFromIso(today);
  if (period === "month") {
    return {
      from: format(new Date(date.getFullYear(), date.getMonth(), 1, 12), "yyyy-MM-dd"),
      to: format(new Date(date.getFullYear(), date.getMonth() + 1, 0, 12), "yyyy-MM-dd"),
    };
  }
  if (period === "year") {
    return { from: `${date.getFullYear()}-01-01`, to: `${date.getFullYear()}-12-31` };
  }
  if (customRange?.from && customRange.to) {
    const from = format(customRange.from, "yyyy-MM-dd");
    const to = format(customRange.to, "yyyy-MM-dd");
    return from <= to ? { from, to } : { from: to, to: from };
  }
  return undefined;
}

function dateFromIso(value: string) {
  return new Date(`${value}T12:00:00`);
}

function cleanSearchTerm(value: string) {
  return value
    .trim()
    .replace(/[,%_()]/g, " ")
    .replace(/\s+/g, " ");
}

function formatActivityDate(date: string) {
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-PH", {
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

function exportRows(rows: ActivityLog[]) {
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

function dataUrlToBytes(dataUrl: string) {
  const encoded = dataUrl.split(",", 2)[1] ?? "";
  const binary = window.atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function downloadFile(file: Blob, filename: string) {
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function fileDate() {
  return new Date().toISOString().slice(0, 10);
}
