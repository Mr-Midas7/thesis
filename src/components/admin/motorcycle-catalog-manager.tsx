import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Pencil } from "lucide-react";
import { forwardRef, useImperativeHandle, useMemo, useState } from "react";
import { toast } from "sonner";

import { ArchiveConfirmationDialog } from "@/components/admin/archive-confirmation-dialog";
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
import { cn } from "@/lib/utils";

type MotorcycleCatalogItem = {
  id: string;
  brand: string | null;
  model: string;
  is_active: boolean;
  is_archived: boolean;
  created_at: string;
};

const blank = {
  brand: "",
  model: "",
  is_active: true,
};

const ALL_BRANDS = "__all_brands__";
const ALL_MODELS = "__all_models__";

export interface MotorcycleCatalogManagerHandle {
  openNew: () => void;
}

export const MotorcycleCatalogManager = forwardRef<MotorcycleCatalogManagerHandle>(
  function MotorcycleCatalogManager(_, ref) {
    const queryClient = useQueryClient();
    const [editing, setEditing] = useState<MotorcycleCatalogItem | null>(null);
    const [open, setOpen] = useState(false);
    const [form, setForm] = useState({ ...blank });
    const [formErrors, setFormErrors] = useState<Partial<Record<"brand" | "model", string>>>({});
    const [filterBrand, setFilterBrand] = useState(ALL_BRANDS);
    const [filterModel, setFilterModel] = useState(ALL_MODELS);
    const [archiveTarget, setArchiveTarget] = useState<string | null>(null);

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

    const modelsForBrand = useMemo(
      () =>
        filterBrand === ALL_BRANDS
          ? []
          : Array.from(
              new Set(
                (catalog.data ?? [])
                  .filter((item) => item.brand === filterBrand)
                  .map((item) => item.model),
              ),
            ).sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" })),
      [catalog.data, filterBrand],
    );

    const filteredItems = useMemo(
      () =>
        (catalog.data ?? []).filter(
          (item) =>
            (filterBrand === ALL_BRANDS || item.brand === filterBrand) &&
            (filterModel === ALL_MODELS || item.model === filterModel),
        ),
      [catalog.data, filterBrand, filterModel],
    );

    const save = useMutation({
      mutationFn: async (): Promise<MotorcycleCatalogItem> => {
        const payload = {
          brand: form.brand.trim(),
          model: form.model.trim(),
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
        toast.success(
          editing ? "Motorcycle catalog item updated." : "Motorcycle catalog item added.",
        );
        closeEditor();
        invalidateCatalogQueries(queryClient);
      },
      onError: (error: Error) => {
        const duplicate = /duplicate key|unique/i.test(error.message);
        setFormErrors({
          model: duplicate
            ? "This brand and model are already in the catalog."
            : `Could not save this catalog item: ${error.message}`,
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
        toast.success("Motorcycle catalog item archived.");
        invalidateCatalogQueries(queryClient);
      },
      onError: (error: Error) =>
        toast.error(`Could not archive this catalog item: ${error.message}`),
    });

    useImperativeHandle(ref, () => ({ openNew }));

    function closeEditor() {
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
        is_active: item.is_active,
      });
      setFormErrors({});
      setOpen(true);
    }

    function validateForm() {
      const errors: typeof formErrors = {};
      const brand = form.brand.trim();
      const model = form.model.trim();

      if (!brand) errors.brand = "Enter the motorcycle brand.";
      if (model.length < 2) errors.model = "Enter a model name with at least 2 characters.";
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
            <Select
              value={filterBrand}
              onValueChange={(value) => {
                setFilterBrand(value);
                setFilterModel(ALL_MODELS);
              }}
            >
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
            <Label className="text-sm">Model</Label>
            <Select
              value={filterModel}
              onValueChange={setFilterModel}
              disabled={filterBrand === ALL_BRANDS}
            >
              <SelectTrigger className="w-full sm:w-56">
                <SelectValue
                  placeholder={filterBrand === ALL_BRANDS ? "Select a brand first" : "All models"}
                />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_MODELS}>All models</SelectItem>
                {modelsForBrand.map((model) => (
                  <SelectItem key={model} value={model}>
                    {modelLabel(filterBrand, model)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {(filterBrand !== ALL_BRANDS || filterModel !== ALL_MODELS) && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setFilterBrand(ALL_BRANDS);
                setFilterModel(ALL_MODELS);
              }}
            >
              Clear
            </Button>
          )}
        </div>

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
              <label className="flex items-center gap-2 text-sm">
                <Switch
                  checked={form.is_active}
                  onCheckedChange={(is_active) => setForm({ ...form, is_active })}
                />
                Visible in booking
              </label>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeEditor}>
                Close
              </Button>
              <Button
                type="button"
                onClick={() => validateForm() && save.mutate()}
                disabled={save.isPending}
              >
                {save.isPending ? "Saving..." : editing ? "Update" : "Save motorcycle"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Card className="max-w-7xl border-border/70 bg-card/60">
          <CardContent className="overflow-x-auto p-0">
            <Table className="admin-data-table admin-balanced-table">
              <colgroup>
                <col style={{ width: "20%" }} />
                <col style={{ width: "24%" }} />
                <col style={{ width: "44%" }} />
                <col style={{ width: "12%" }} />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead>Date Created</TableHead>
                  <TableHead>Brand</TableHead>
                  <TableHead>Model</TableHead>
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
                    <TableCell
                      data-label="Actions"
                      className="space-x-1 whitespace-nowrap text-center"
                    >
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
