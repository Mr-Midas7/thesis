import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Download, FileText, RefreshCw, Search } from "lucide-react";
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
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

function ActivityLogPage() {
  const pageSize = 10;
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  
  const [action, setAction] = useState("all");
  const [resource, setResource] = useState("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  
  const [page, setPage] = useState(0);
  const [pendingExport, setPendingExport] = useState<ExportFormat | null>(null);
  const deferredSearch = useDeferredValue(search);
 

  const hasFilters = Boolean(
    search.trim() ||
    
    action !== "all" ||
    resource !== "all" ||
    fromDate ||
    toDate
    ,
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
    ...(fromDate ? [{ label: "From", value: fromDate, onClear: () => setFromDate("") }] : []),
    ...(toDate ? [{ label: "To", value: toDate, onClear: () => setToDate("") }] : []),
    
  ];
  const filterDescription = useMemo(() => {
    if (!hasFilters) return "Showing 10 records per page from the last 50 days.";
    return `Showing page ${page + 1} of ${logs.data?.total ?? 0} matching records from the last 50 days.`;
  }, [hasFilters, logs.data?.total, page]);

  useEffect(() => {
    setPage(0);
  }, [search, action, resource, fromDate, toDate]);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["admin-activity-logs"] });
  }

  function clearFilters() {
    setSearch("");
    setAction("all");
    setResource("all");
    setFromDate("");
    setToDate("");
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
        <CardContent className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-1.5 xl:col-span-2">
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
          <div className="space-y-1.5">
            <Label htmlFor="activity-from-date">From date</Label>
            <Input
              id="activity-from-date"
              type="date"
              value={fromDate}
              max={toDate || undefined}
              onChange={(event) => setFromDate(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="activity-to-date">To date</Label>
            <Input
              id="activity-to-date"
              type="date"
              value={toDate}
              min={fromDate || undefined}
              onChange={(event) => setToDate(event.target.value)}
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
