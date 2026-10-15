import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Pencil, Plus, UserCheck } from "lucide-react";
import { useState } from "react";

import { ArchiveConfirmationDialog } from "@/components/admin/archive-confirmation-dialog";
import {
  ActiveStatusBadge,
  AdminPage,
  ArchiveMenuItem,
  DataList,
  InlineAlert,
  ListCard,
  ListEmpty,
  ListToolbar,
  MoreActionsMenu,
  ResetFiltersButton,
  ToolbarFilters,
  ToolbarSearch,
} from "@/components/admin/data-list";
import { PageHeader } from "@/components/admin/page-header";
import { Button } from "@/components/ui/button";
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
import { supabase } from "@/integrations/supabase/client";
import {
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
        phone: form.phone ? normalizePhilippineMobile(form.phone) : null,
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
            phone: form.phone ? normalizePhilippineMobile(form.phone) : null,
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

  const searchTerm = filterName.trim().toLocaleLowerCase();
  const filteredCrew = (crew.data ?? []).filter(
    (c) =>
      (!searchTerm ||
        `${c.name} ${c.role} ${c.phone ? toLocalPhilippineMobile(c.phone) : ""}`
          .toLocaleLowerCase()
          .includes(searchTerm)) &&
      (filterStatus === "all" || (filterStatus === "active" ? c.is_active : !c.is_active)),
  );
  const activeCount = (crew.data ?? []).filter((c) => c.is_active).length;
  const hasFilters = Boolean(searchTerm) || filterStatus !== "all";
  const resetFilters = () => {
    setFilterName("");
    setFilterStatus("all");
  };
  const openNew = () => {
    setEditing(null);
    setForm({ ...blank });
    setFormErrors({});
    setOpen(true);
  };
  const openEdit = (c: CrewMember) => {
    setEditing(c);
    setForm({
      name: c.name,
      role: c.role,
      phone: c.phone ? toLocalPhilippineMobile(c.phone) : "",
      is_active: c.is_active,
    });
    setFormErrors({});
    setOpen(true);
  };

  return (
    <AdminPage>
      <PageHeader
        title="Mechanics"
        description="Manage mechanics and view their current work status."
        action={
          <Button className="font-display uppercase" onClick={openNew}>
            <Plus /> Add mechanic
          </Button>
        }
      />
      {archiveError && <InlineAlert>{archiveError}</InlineAlert>}

      <ListToolbar
        summary={crew.data && `Showing ${filteredCrew.length} of ${crew.data.length} mechanics`}
      >
        <ToolbarSearch
          value={filterName}
          onChange={setFilterName}
          placeholder="Search name, role, or phone"
          label="Search mechanics by name, role, or phone"
        />
        <ToolbarFilters>
          <Select
            value={filterStatus}
            onValueChange={(value) => setFilterStatus(value as "all" | "active" | "inactive")}
          >
            <SelectTrigger aria-label="Filter by status" className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active ({activeCount})</SelectItem>
              <SelectItem value="inactive">
                Inactive ({(crew.data?.length ?? 0) - activeCount})
              </SelectItem>
            </SelectContent>
          </Select>
          {hasFilters && <ResetFiltersButton onClick={resetFilters} />}
        </ToolbarFilters>
      </ListToolbar>

      <ListCard>
        <DataList
          label="Mechanics"
          rows={filteredCrew}
          rowKey={(c) => c.id}
          loading={crew.isLoading}
          error={
            crew.isError
              ? { message: "Could not load mechanics.", onRetry: () => void crew.refetch() }
              : null
          }
          empty={
            <ListEmpty
              icon={UserCheck}
              title={hasFilters ? "No mechanics match your filters." : "No mechanics yet."}
              description={
                hasFilters
                  ? "Try a different search or status."
                  : "Add your crew so you can assign them to appointments."
              }
              action={
                hasFilters ? (
                  <ResetFiltersButton onClick={resetFilters} />
                ) : (
                  <Button size="sm" onClick={openNew}>
                    <Plus /> Add mechanic
                  </Button>
                )
              }
            />
          }
          columns={[
            {
              key: "name",
              header: "Name",
              card: "title",
              cell: (c) => <span className="font-medium">{c.name}</span>,
            },
            {
              key: "role",
              header: "Role",
              className: "w-32",
              cell: (c) => <span className="text-sm">{c.role}</span>,
            },
            {
              key: "phone",
              header: "Phone",
              className: "w-36",
              cell: (c) => (
                <span className="text-sm">
                  {c.phone ? (
                    toLocalPhilippineMobile(c.phone)
                  ) : (
                    <span className="text-muted-foreground">Not set</span>
                  )}
                </span>
              ),
            },
            {
              key: "status",
              header: "Status",
              card: "badge",
              className: "w-28 text-center",
              cell: (c) => <ActiveStatusBadge active={c.is_active} />,
            },
          ]}
          actionsClassName="w-36"
          actions={(c) => (
            <>
              <Button size="sm" variant="outline" onClick={() => openEdit(c)}>
                <Pencil /> Edit
              </Button>
              <MoreActionsMenu itemLabel={c.name}>
                <ArchiveMenuItem
                  disabled={archive.isPending}
                  onSelect={() => setArchiveTarget(c.id)}
                />
              </MoreActionsMenu>
            </>
          )}
        />
      </ListCard>

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
    </AdminPage>
  );
}
