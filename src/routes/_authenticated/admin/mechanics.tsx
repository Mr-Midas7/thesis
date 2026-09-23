import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Archive, Pencil, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";

import { PageHeader } from "@/components/admin/page-header";
import { ArchiveConfirmationDialog } from "@/components/admin/archive-confirmation-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FieldError } from "@/components/ui/field-error";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
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
  activeStatusTone,
  PHONE_VALIDATION_MESSAGE,
  normalizePhilippineMobile,
  sanitizePhilippineMobileInput,
  toLocalPhilippineMobile,
} from "@/lib/shop";

export const Route = createFileRoute("/_authenticated/admin/mechanics")({
  component: MechanicsPage,
});

type CrewMember = {
  id: string;
  name: string;
  role: string;
  phone: string | null;
  is_active: boolean;
  is_archived: boolean;
};

const blank = { name: "", role: "Mechanic", phone: "", is_active: true };

function MechanicsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CrewMember | null>(null);
  const [form, setForm] = useState({ ...blank });
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<
    Partial<Record<"name" | "phone", string | undefined>>
  >({});
  const [filterStatus, setFilterStatus] = useState<"all" | "active" | "inactive">("all");
  const [filterName, setFilterName] = useState("");
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const crew = useQuery({
    queryKey: ["crew-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("crew_members")
        .select("*")
        .eq("is_archived", false)
        .order("name");
      if (error) throw error;
      const seen = new Set<string>();
      const deduped: CrewMember[] = [];
      for (const c of data as CrewMember[]) {
        if (seen.has(c.name.trim())) continue;
        seen.add(c.name.trim());
        deduped.push(c);
      }
      return deduped;
    },
  });

  const add = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("crew_members").insert({
        name: form.name.trim(),
        role: form.role.trim() || "Mechanic",
        phone: form.phone.trim() || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      setForm({ ...blank });
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["crew-all"] });
    },
    onError: (err: Error) => {
      console.error("Add failed:", err);
      setFormErrors({ name: "Could not add this mechanic. Please try again." });
    },
  });

  const archive = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("crew_members")
        .update({ is_archived: true })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_, id) => {
      qc.setQueryData<CrewMember[]>(["crew-all"], (items) =>
        items?.filter((member) => member.id !== id),
      );
      setArchiveError(null);
      qc.invalidateQueries({ queryKey: ["crew-all"], exact: false });
      qc.invalidateQueries({ queryKey: ["archived-crew"], exact: false });
    },
    onError: (err: Error) => {
      console.error("Archive failed:", err);
      setArchiveError("Could not archive this mechanic. Please try again.");
    },
  });

  const getStatus = (member: CrewMember) => ({
    label: member.is_active ? "Active" : "Inactive",
    tone: activeStatusTone(member.is_active),
  });

  const handleSave = async () => {
    if (form.name.trim().length < 2) {
      setFormErrors({ name: "Enter a mechanic name with at least 2 characters." });
      return;
    }
    if (form.phone && !normalizePhilippineMobile(form.phone)) {
      setFormErrors({ phone: PHONE_VALIDATION_MESSAGE });
      return;
    }
    setFormErrors({});
    if (editing) {
      setIsSaving(true);
      try {
        const { error } = await supabase
          .from("crew_members")
          .update({
            name: form.name.trim(),
            role: form.role.trim() || "Mechanic",
            phone: form.phone.trim() || null,
            is_active: form.is_active,
          })
          .eq("id", editing.id);
        if (error) {
          setFormErrors({ name: "Could not update this mechanic. Please try again." });
          return;
        }
      } finally {
        setIsSaving(false);
      }
    } else {
      add.mutate();
      return;
    }
    setEditing(null);
    setForm({ ...blank });
    setOpen(false);
    qc.invalidateQueries({ queryKey: ["crew-all"] });
  };

  return (
    <div>
      <PageHeader
        title="Mechanics"
        description="Manage mechanics and view their current work status."
        action={
          <Button
            className="font-display uppercase"
            onClick={() => {
              setEditing(null);
              setForm({ ...blank });
              setFormErrors({});
              setOpen(true);
            }}
          >
            <Plus /> Add mechanic
          </Button>
        }
      />
      {archiveError && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {archiveError}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label className="text-sm">Name</Label>
          <Input
            value={filterName}
            onChange={(e) => setFilterName(e.target.value)}
            placeholder="Search by name..."
            className="w-full sm:w-48"
          />
        </div>

        <div className="space-y-1.5">
          <Label className="text-sm">Status</Label>
          <Select
            value={filterStatus}
            onValueChange={(value) => setFilterStatus(value as "all" | "active" | "inactive")}
          >
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {(filterName || filterStatus !== "all") && (
          <Button
            size="sm"
            variant="outline"
            className="self-end whitespace-nowrap"
            onClick={() => {
              setFilterName("");
              setFilterStatus("all");
            }}
          >
            <RotateCcw /> Reset
          </Button>
        )}
      </div>

      <Card className="max-w-6xl border-border/70 bg-card/60">
        <CardContent className="overflow-x-auto p-0">
          <Table className="admin-data-table admin-balanced-table">
            <colgroup>
              <col style={{ width: "27%" }} />
              <col style={{ width: "27%" }} />
              <col style={{ width: "22%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "15%" }} />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Role</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="text-center">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {crew.data
                ?.filter((c) => c.name.toLowerCase().includes(filterName.toLowerCase()))
                .filter(
                  (c) =>
                    filterStatus === "all" ||
                    (filterStatus === "active" ? c.is_active : !c.is_active),
                )
                .map((c) => {
                  const status = getStatus(c);
                  return (
                    <TableRow key={c.id}>
                      <TableCell data-label="Name" className="text-sm">
                        {c.name}
                      </TableCell>
                      <TableCell data-label="Role" className="text-sm">
                        {c.role}
                      </TableCell>
                      <TableCell data-label="Phone" className="text-sm">
                        {c.phone ?? "-"}
                      </TableCell>
                      <TableCell data-label="Status" className="text-center">
                        <Badge variant="outline" className={`text-[10px] uppercase ${status.tone}`}>
                          {status.label}
                        </Badge>
                      </TableCell>
                      <TableCell data-label="Actions" className="space-x-1 text-center">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            setEditing(c);
                            setForm({
                              name: c.name,
                              role: c.role,
                              phone: c.phone ? toLocalPhilippineMobile(c.phone) : "",
                              is_active: c.is_active,
                            });
                            setFormErrors({});
                            setOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={archive.isPending}
                          onClick={() => setArchiveTarget(c.id)}
                        >
                          <Archive className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
          {crew.data
            ?.filter((c) => c.name.toLowerCase().includes(filterName.toLowerCase()))
            .filter(
              (c) =>
                filterStatus === "all" || (filterStatus === "active" ? c.is_active : !c.is_active),
            ).length === 0 && (
            <p className="p-8 text-center text-sm text-muted-foreground">No mechanics found.</p>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-display uppercase">
              {editing ? "Edit mechanic" : "New mechanic"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={form.name}
                onChange={(e) => {
                  setForm({ ...form, name: e.target.value });
                  setFormErrors((current) => ({ ...current, name: undefined }));
                }}
                aria-invalid={!!formErrors.name}
              />
              <FieldError message={formErrors.name} />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Input
                value={form.role}
                onChange={(e) => {
                  setForm({ ...form, role: e.target.value });
                }}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Phone</Label>
              <Input
                type="tel"
                value={form.phone}
                maxLength={11}
                inputMode="numeric"
                onChange={(e) => {
                  setForm({ ...form, phone: sanitizePhilippineMobileInput(e.target.value) });
                  setFormErrors((current) => ({ ...current, phone: undefined }));
                }}
                placeholder="09171234567"
                aria-invalid={!!formErrors.phone}
              />
              <FieldError message={formErrors.phone} />
            </div>
            {editing && (
              <div className="space-y-1.5 rounded-lg border border-border/70 bg-muted/20 p-3">
                <Label htmlFor="mechanic-active">Status</Label>
                <label className="flex items-center gap-2 text-sm" htmlFor="mechanic-active">
                  <Switch
                    id="mechanic-active"
                    checked={form.is_active}
                    onCheckedChange={(is_active) =>
                      setForm((current) => ({ ...current, is_active }))
                    }
                  />
                  <span
                    className={
                      form.is_active
                        ? "font-medium text-emerald-600 dark:text-emerald-300"
                        : "font-medium text-muted-foreground"
                    }
                  >
                    {form.is_active ? "Active" : "Inactive"}
                  </span>
                </label>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button onClick={handleSave} disabled={add.isPending || isSaving || !form.name.trim()}>
              {add.isPending || isSaving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ArchiveConfirmationDialog
        open={Boolean(archiveTarget)}
        recordLabel="mechanic"
        pending={archive.isPending}
        onOpenChange={(nextOpen) => !nextOpen && setArchiveTarget(null)}
        onConfirm={() => {
          if (archiveTarget) archive.mutate(archiveTarget);
          setArchiveTarget(null);
        }}
      />
    </div>
  );
}
