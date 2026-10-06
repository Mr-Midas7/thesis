import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Eye, Pencil, RotateCcw } from "lucide-react";
import { forwardRef, useImperativeHandle, useMemo, useState } from "react";

import { ArchiveConfirmationDialog } from "@/components/admin/archive-confirmation-dialog";
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

type MotorcycleCatalogItem = {
  id: string;
  brand: string | null;
  cc_category: string | null;
  model: string;
  engine_cc: number | null;
  is_active: boolean;
  is_archived: boolean;
  created_at: string;
};

const blank = {
  brand: "",
  model: "",
  engineCc: "",
  is_active: true,
};

const ALL_BRANDS = "__all_brands__";

export interface MotorcycleCatalogManagerHandle {
  openNew: () => void;
}

export const MotorcycleCatalogManager = forwardRef<MotorcycleCatalogManagerHandle>(
  function MotorcycleCatalogManager(_, ref) {
    const queryClient = useQueryClient();
    const [editing, setEditing] = useState<MotorcycleCatalogItem | null>(null);
    const [viewing, setViewing] = useState<MotorcycleCatalogItem | null>(null);
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState({ ...blank });
    const [formErrors, setFormErrors] = useState<
      Partial<Record<"brand" | "model" | "engineCc", string>>
    >({});
    const [filterBrand, setFilterBrand] = useState(ALL_BRANDS);
    const [modelSearch, setModelSearch] = useState("");
    const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
    const [saveConfirmationOpen, setSaveConfirmationOpen] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    const catalog = useQuery({
      queryKey: ["admin-motorcycle-catalog"],
      queryFn: async (): Promise<MotorcycleCatalogItem[]> => {
        const { data, error } = await supabase
          .from("motorcycle_catalog")
          .select("*")
          .eq("is_archived", false)
          .order("brand")
          .order("model");
        if (error) throw error;
        return data as MotorcycleCatalogItem[];
      },
    });

    const brands = useMemo(
      () =>
        Array.from(
          new Set(
            (catalog.data ?? []).flatMap((item) => (item.brand?.trim() ? [item.brand.trim()] : [])),
          ),
        ).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" })),
      [catalog.data],
    );

    const modelSearchTerms = useMemo(
      () => modelSearch.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean),
      [modelSearch],
    );

    const filteredItems = useMemo(() => {
      const filtered = (catalog.data ?? []).filter(
        (item) =>
          (filterBrand === ALL_BRANDS || item.brand === filterBrand) &&
          modelSearchTerms.every((term) => item.model.toLocaleLowerCase().includes(term)),
      );
      return filtered.sort(
        (left, right) =>
          (left.brand ?? "").localeCompare(right.brand ?? "", undefined, {
            sensitivity: "base",
          }) || left.model.localeCompare(right.model, undefined, { sensitivity: "base" }),
      );
    }, [catalog.data, filterBrand, modelSearchTerms]);

    const save = useMutation({
      mutationFn: async (): Promise<MotorcycleCatalogItem> => {
        const payload = {
          brand: form.brand.trim(),
          model: form.model.trim(),
          engine_cc: form.engineCc.trim() ? Number(form.engineCc) : null,
          is_active: form.is_active,
        };
        const result = editing
          ? await supabase
              .from("motorcycle_catalog")
              .update(payload)
              .eq("id", editing.id)
              .select()
              .single()
          : await supabase.from("motorcycle_catalog").insert(payload).select().single();
        if (result.error) throw result.error;
        return result.data as MotorcycleCatalogItem;
      },
      onSuccess: () => {
        setSaveConfirmationOpen(false);
        closeEditor();
        invalidateCatalogQueries(queryClient);
      },
      onError: (error: Error) => {
        setSaveConfirmationOpen(false);
        const duplicate = /duplicate key|unique/i.test(error.message);
        setFormErrors({
          model: duplicate
            ? "This brand and model are already in the catalog."
            : "Could not save this catalog item. Please try again.",
        });
      },
    });

    const archive = useMutation({
      mutationFn: async (id: string) => {
        const { error } = await supabase
          .from("motorcycle_catalog")
          .update({ is_archived: true })
          .eq("id", id);
        if (error) throw error;
      },
      onSuccess: () => {
        setActionError(null);
        invalidateCatalogQueries(queryClient);
      },
      onError: (error: Error) => {
        console.error("Could not archive motorcycle catalog item:", error);
        setActionError("Could not archive this motorcycle catalog item. Please try again.");
      },
    });

    useImperativeHandle(ref, () => ({ openNew }));

    function closeEditor() {
      setSaveConfirmationOpen(false);
      setOpen(false);
      setEditing(null);
      setForm({ ...blank });
      setFormErrors({});
    }

    function openNew() {
      setEditing(null);
      setForm({ ...blank });
      setFormErrors({});
      setOpen(true);
    }

    function openEdit(item: MotorcycleCatalogItem) {
      setEditing(item);
      setForm({
        brand: item.brand ?? "",
        model: item.model,
        engineCc: item.engine_cc === null ? "" : String(item.engine_cc),
        is_active: item.is_active,
      });
      setFormErrors({});
      setOpen(true);
    }

    function validateForm() {
      const errors: typeof formErrors = {};
      const brand = form.brand.trim();
      const model = form.model.trim();
      const hasEngineCc = Boolean(form.engineCc.trim());
      const engineCc = Number(form.engineCc);

      if (!brand) errors.brand = "Enter the motorcycle brand.";
      if (model.length < 2) errors.model = "Enter a model name with at least 2 characters.";
      if (hasEngineCc && (!Number.isFinite(engineCc) || engineCc <= 0 || engineCc > 99999.9)) {
        errors.engineCc = "Enter a valid engine displacement in CC.";
      }
      if (!hasEngineCc && !editing) {
        errors.engineCc = "Enter the motorcycle engine displacement in CC.";
      }
      if (!hasEngineCc && form.is_active) {
        errors.engineCc = "A motorcycle without a combustion CC must remain inactive.";
      }
      if (
        brand &&
        model &&
        (catalog.data ?? []).some(
          (item) =>
            item.id !== editing?.id &&
            item.brand?.trim().toLocaleLowerCase() === brand.toLocaleLowerCase() &&
            item.model.trim().toLocaleLowerCase() === model.toLocaleLowerCase(),
        )
      ) {
        errors.model = "This brand and model are already in the catalog.";
      }

      setFormErrors(errors);
      return Object.keys(errors).length === 0;
    }

    function requestSave() {
      if (!validateForm()) return;
      if (editing) {
        setSaveConfirmationOpen(true);
        return;
      }
      save.mutate();
    }

    function clearFormError(field: keyof typeof formErrors) {
      setFormErrors((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
    }

    return (
      <>
        <div className="mb-4 flex flex-wrap items-end gap-4">
          <div className="space-y-1.5">
            <Label className="text-sm">Brand</Label>
            <Select value={filterBrand} onValueChange={setFilterBrand}>
              <SelectTrigger className="w-full sm:w-48">
                <SelectValue placeholder="All brands" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_BRANDS}>All brands</SelectItem>
                {brands.map((brand) => (
                  <SelectItem key={brand} value={brand}>
                    {brand}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="catalog-model-search" className="text-sm">
              Model
            </Label>
            <Input
              id="catalog-model-search"
              value={modelSearch}
              onChange={(event) => setModelSearch(event.target.value)}
              placeholder="Search models..."
              className="w-full sm:w-56"
            />
          </div>
          {(filterBrand !== ALL_BRANDS || modelSearch.trim()) && (
            <Button
              size="sm"
              variant="outline"
              className="self-end whitespace-nowrap"
              onClick={() => {
                setFilterBrand(ALL_BRANDS);
                setModelSearch("");
              }}
            >
              <RotateCcw /> Reset
            </Button>
          )}
        </div>

        {actionError && (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {actionError}
          </p>
        )}

        <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && closeEditor()}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-display uppercase">
                {editing ? "Edit motorcycle" : "New motorcycle"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="motorcycle-brand">Brand</Label>
                <Input
                  id="motorcycle-brand"
                  list="motorcycle-brand-options"
                  value={form.brand}
                  onChange={(event) => {
                    setForm({ ...form, brand: event.target.value });
                    clearFormError("brand");
                  }}
                  placeholder="Type or select a brand"
                  aria-invalid={Boolean(formErrors.brand)}
                />
                <datalist id="motorcycle-brand-options">
                  {brands.map((brand) => (
                    <option key={brand} value={brand} />
                  ))}
                </datalist>
                <FieldError message={formErrors.brand} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="motorcycle-model">Model name</Label>
                <Input
                  id="motorcycle-model"
                  value={form.model}
                  onChange={(event) => {
                    setForm({ ...form, model: event.target.value });
                    clearFormError("model");
                  }}
                  aria-invalid={Boolean(formErrors.model)}
                />
                <FieldError message={formErrors.model} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="motorcycle-engine-cc">Engine displacement (CC)</Label>
                <Input
                  id="motorcycle-engine-cc"
                  type="number"
                  min="0.1"
                  max="99999.9"
                  step="0.1"
                  inputMode="decimal"
                  value={form.engineCc}
                  onChange={(event) => {
                    setForm({ ...form, engineCc: event.target.value });
                    clearFormError("engineCc");
                  }}
                  placeholder="e.g. 125"
                  aria-invalid={Boolean(formErrors.engineCc)}
                />
                <p className="text-xs text-muted-foreground">
                  125CC and below are Small Bike; 126CC and above are Large Bike.
                </p>
                {form.engineCc.trim() && (
                  <p className="text-xs text-muted-foreground">
                    Category: {ccCategoryLabelFromEngineCc(Number(form.engineCc))}
                  </p>
                )}
                {!form.engineCc.trim() && editing && (
                  <p className="text-xs text-muted-foreground">
                    This record has no combustion CC and must stay inactive.
                  </p>
                )}
                <FieldError message={formErrors.engineCc} />
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    id="motorcycle-active"
                    checked={form.is_active}
                    onCheckedChange={(is_active) => setForm({ ...form, is_active })}
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
                <p className="text-xs text-muted-foreground">
                  Inactive motorcycles are hidden from customer booking.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeEditor}>
                Close
              </Button>
              <Button type="button" onClick={requestSave} disabled={save.isPending}>
                {save.isPending ? "Saving..." : editing ? "Update" : "Save motorcycle"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={Boolean(viewing)} onOpenChange={(nextOpen) => !nextOpen && setViewing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="font-display uppercase">Motorcycle details</DialogTitle>
            </DialogHeader>
            {viewing && (
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
                <dt className="text-muted-foreground">Brand</dt>
                <dd>{viewing.brand ?? "-"}</dd>
                <dt className="text-muted-foreground">Model</dt>
                <dd>{modelLabel(viewing.brand, viewing.model)}</dd>
                <dt className="text-muted-foreground">Engine displacement</dt>
                <dd>{viewing.engine_cc === null ? "Not applicable" : `${viewing.engine_cc}cc`}</dd>
                <dt className="text-muted-foreground">Category</dt>
                <dd>{ccCategoryLabel(viewing.cc_category)}</dd>
                <dt className="text-muted-foreground">Status</dt>
                <dd>{viewing.is_active ? "Active" : "Inactive"}</dd>
              </dl>
            )}
            <DialogFooter>
              <Button type="button" onClick={() => setViewing(null)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Card className="max-w-7xl border-border/70 bg-card/60">
          <CardContent className="overflow-x-auto p-0">
            <Table className="admin-data-table admin-balanced-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Date Created</TableHead>
                  <TableHead>Brand</TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-center">Status</TableHead>
                  <TableHead className="text-center">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell
                      data-label="Created on"
                      className="whitespace-nowrap text-xs text-muted-foreground"
                    >
                      {formatCreatedOn(item.created_at)}
                    </TableCell>
                    <TableCell data-label="Brand" className="text-sm">
                      {item.brand ?? "-"}
                    </TableCell>
                    <TableCell data-label="Model" className="text-sm">
                      {modelLabel(item.brand, item.model)}
                    </TableCell>
                    <TableCell data-label="Status" className="text-center">
                      <span
                        className={
                          item.is_active
                            ? "text-sm font-medium text-emerald-600 dark:text-emerald-300"
                            : "text-sm font-medium text-muted-foreground"
                        }
                      >
                        {item.is_active ? "Active" : "Inactive"}
                      </span>
                    </TableCell>
                    <TableCell
                      data-label="Actions"
                      className="space-x-1 whitespace-nowrap text-center"
                    >
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`View ${item.brand ?? ""} ${item.model}`.trim()}
                        onClick={() => setViewing(item)}
                      >
                        <Eye className="size-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Edit ${item.brand ?? ""} ${item.model}`.trim()}
                        onClick={() => openEdit(item)}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Archive ${item.brand ?? ""} ${item.model}`.trim()}
                        onClick={() => setArchiveTarget(item.id)}
                      >
                        <Archive className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {!catalog.isLoading && filteredItems.length === 0 && (
              <p className="p-8 text-center text-sm text-muted-foreground">Nothing here yet.</p>
            )}
            {catalog.isError && (
              <p className="p-8 text-center text-sm text-destructive">
                Could not load the motorcycle catalog. Please try again.
              </p>
            )}
          </CardContent>
        </Card>
        <AlertDialog open={saveConfirmationOpen} onOpenChange={setSaveConfirmationOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Save motorcycle changes?</AlertDialogTitle>
              <AlertDialogDescription>
                This will update the selected motorcycle record and its customer booking visibility.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={save.isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={save.isPending} onClick={() => save.mutate()}>
                Save Changes
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <ArchiveConfirmationDialog
          open={Boolean(archiveTarget)}
          recordLabel="motorcycle catalog item"
          pending={archive.isPending}
          onOpenChange={(nextOpen) => !nextOpen && setArchiveTarget(null)}
          onConfirm={() => {
            if (archiveTarget) archive.mutate(archiveTarget);
            setArchiveTarget(null);
          }}
        />
      </>
    );
  },
);

function invalidateCatalogQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ["admin-motorcycle-catalog"], exact: false });
  queryClient.invalidateQueries({ queryKey: ["motorcycle-catalog"], exact: false });
  queryClient.invalidateQueries({ queryKey: ["admin-service-model-catalog"], exact: false });
  queryClient.invalidateQueries({ queryKey: ["archived-motorcycles"], exact: false });
}

function formatCreatedOn(createdAt: string) {
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(createdAt));
}

function modelLabel(brand: string | null, model: string) {
  const prefix = brand ? `${brand} ` : "";
  return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

function ccCategoryLabel(category: string | null) {
  if (category === "small_bike") return "Small Bike";
  if (category === "big_bike") return "Large Bike";
  return "Needs CC";
}

function ccCategoryLabelFromEngineCc(engineCc: number) {
  if (!Number.isFinite(engineCc) || engineCc <= 0) return "Needs CC";
  return engineCc <= 125 ? "Small Bike" : "Large Bike";
}
