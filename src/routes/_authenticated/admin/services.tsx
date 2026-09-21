import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Archive, EllipsisVertical, Eye, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ArchiveConfirmationDialog } from "@/components/admin/archive-confirmation-dialog";
import { PageHeader } from "@/components/admin/page-header";
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
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { supabase } from "@/integrations/supabase/client";
import { activeStatusTone, formatPHP } from "@/lib/shop";

export const Route = createFileRoute("/_authenticated/admin/services")({
  component: ServicesAdmin,
});

type Service = {
  id: string;
  name: string;
  description: string | null;
  price: number | string;
  duration_minutes: number;
  is_active: boolean;
  is_archived: boolean;
  category: string;
  created_at: string;
};

type ModelOverride = {
  id?: string;
  service_id?: string;
  brand: string;
  model: string;
  duration_minutes: number;
  price: number;
};

type MotorcycleCatalogItem = {
  brand: string;
  model: string;
};

type ServiceForm = {
  name: string;
  category: string;
  description: string;
  defaultPrice: number;
  defaultDuration: number;
  isActive: boolean;
};

const blank: ServiceForm = {
  name: "",
  category: "general",
  description: "",
  defaultPrice: 0,
  defaultDuration: 60,
  isActive: true,
};
const ALL_CATEGORIES = "__all_categories__";
const NEW_CATEGORY = "__new_category__";
const DEFAULT_MODEL_OVERRIDES: ModelOverride[] = [];

const cloneOverrides = (items: ModelOverride[]) => items.map((item) => ({ ...item }));

function ServicesAdmin() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);
  const [viewing, setViewing] = useState<Service | null>(null);
  const [form, setForm] = useState<ServiceForm>({ ...blank });
  const [modelOverrides, setModelOverrides] = useState<ModelOverride[]>([]);
  const [editingOverride, setEditingOverride] = useState<number | null>(null);
  const [isCustomCategory, setIsCustomCategory] = useState(false);
  const [formErrors, setFormErrors] = useState<
    Partial<Record<"name" | "category" | "defaultPrice" | "defaultDuration", string | undefined>>
  >({});
  const [filterCategory, setFilterCategory] = useState<string>(ALL_CATEGORIES);
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const [saveConfirmationOpen, setSaveConfirmationOpen] = useState(false);

  const services = useQuery({
    queryKey: ["admin-services"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("services")
        .select("*")
        .eq("is_archived", false)
        .order("sort_order");
      if (error) throw error;
      return (data ?? []) as Service[];
    },
  });

  const savedModelOverrides = useQuery({
    queryKey: ["service-model-overrides"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("service_model_overrides")
        .select("id,service_id,brand,model,duration_minutes,price")
        .order("created_at");
      if (error) throw error;
      return data as ModelOverride[];
    },
  });

  const motorcycleCatalog = useQuery({
    queryKey: ["admin-service-model-catalog"],
    queryFn: async (): Promise<MotorcycleCatalogItem[]> => {
      const { data, error } = await supabase
        .from("motorcycle_catalog")
        .select("brand,model")
        .eq("is_active", true)
        .eq("is_archived", false)
        .order("brand")
        .order("model");
      if (error) throw error;
      return Array.from(
        new Map(
          (data ?? [])
            .filter((item): item is MotorcycleCatalogItem => Boolean(item.brand && item.model))
            .map((item) => [`${item.brand}:${item.model}`, item]),
        ).values(),
      );
    },
  });

  const distinctCategories = useMemo(() => {
    if (!services.data) return [];
    return Array.from(
      new Set(services.data.map((service) => service.category).filter(Boolean)),
    ).sort();
  }, [services.data]);
  const categoryOptions = useMemo(
    () => Array.from(new Set([blank.category, ...distinctCategories])).sort(),
    [distinctCategories],
  );
  const motorcycleBrands = useMemo(
    () => Array.from(new Set((motorcycleCatalog.data ?? []).map((item) => item.brand))).sort(),
    [motorcycleCatalog.data],
  );

  const motorcycleModelsForBrand = (brand: string) =>
    (motorcycleCatalog.data ?? [])
      .filter((item) => item.brand === brand)
      .map((item) => item.model)
      .filter((name, index, values) => values.indexOf(name) === index)
      .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));

  const overridesFor = (serviceId: string) => {
    return (savedModelOverrides.data ?? []).filter((item) => item.service_id === serviceId);
  };

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name.trim(),
        category: form.category.trim().toLowerCase(),
        description: form.description.trim() || null,
        duration_minutes: form.defaultDuration,
        is_active: form.isActive,
      };

      let serviceId = editing?.id;
      if (serviceId) {
        const { error } = await supabase.from("services").update(payload).eq("id", serviceId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("services")
          .insert({ ...payload, price: form.defaultPrice })
          .select("id")
          .single();
        if (error) throw error;
        serviceId = data.id;
      }

      const existingOverrides = editing ? overridesFor(editing.id) : [];
      const retainedOverrideIds = new Set(
        modelOverrides.flatMap((override) => (override.id ? [override.id] : [])),
      );
      for (const override of existingOverrides.filter(
        (item) => !retainedOverrideIds.has(item.id ?? ""),
      )) {
        const { error } = await supabase
          .from("service_model_overrides")
          .delete()
          .eq("id", override.id!);
        if (error) throw error;
      }
      for (const override of modelOverrides.filter((item) => item.id)) {
        const { error } = await supabase
          .from("service_model_overrides")
          .update({
            brand: override.brand,
            model: override.model,
            duration_minutes: override.duration_minutes,
          })
          .eq("id", override.id!);
        if (error) throw error;
      }
      const newOverrides = modelOverrides.filter((override) => !override.id);
      if (newOverrides.length > 0) {
        const { error } = await supabase.from("service_model_overrides").insert(
          newOverrides.map(({ id: _id, service_id: _serviceId, ...override }) => ({
            ...override,
            service_id: serviceId,
          })),
        );
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success("Service saved");
      setSaveConfirmationOpen(false);
      closeEditor();
      qc.invalidateQueries({ queryKey: ["admin-services"] });
      qc.invalidateQueries({ queryKey: ["service-model-overrides"] });
      qc.invalidateQueries({ queryKey: ["prices"], exact: false });
      qc.invalidateQueries({ queryKey: ["services"], exact: false });
    },
    onError: (error: Error) => {
      setSaveConfirmationOpen(false);
      toast.error(`Could not save the service: ${error.message}`);
    },
  });

  const archive = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("services").update({ is_archived: true }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: (_, id) => {
      qc.setQueryData<Service[]>(["admin-services"], (items) =>
        items?.filter((service) => service.id !== id),
      );
      toast.success("Service archived");
      qc.invalidateQueries({ queryKey: ["admin-services"], exact: false });
      qc.invalidateQueries({ queryKey: ["archived-services"], exact: false });
    },
    onError: (error: Error) => toast.error(`Archive failed: ${error.message}`),
  });

  function closeEditor() {
    setOpen(false);
    setEditing(null);
    setForm({ ...blank });
    setModelOverrides([]);
    setEditingOverride(null);
    setIsCustomCategory(false);
    setFormErrors({});
  }

  function openEditor(service?: Service) {
    setEditing(service ?? null);
    setForm(
      service
        ? {
            name: service.name,
            category: service.category,
            description: service.description ?? "",
            defaultPrice: Number(service.price),
            defaultDuration: service.duration_minutes ?? 60,
            isActive: service.is_active,
          }
        : { ...blank },
    );
    setModelOverrides(
      service ? cloneOverrides(overridesFor(service.id)) : cloneOverrides(DEFAULT_MODEL_OVERRIDES),
    );
    setEditingOverride(null);
    setIsCustomCategory(false);
    setFormErrors({});
    setOpen(true);
  }

  function validateForm() {
    const nextErrors: Partial<
      Record<"name" | "category" | "defaultPrice" | "defaultDuration", string>
    > = {};
    if (form.name.trim().length < 2)
      nextErrors.name = "Enter a service name with at least 2 characters.";
    if (form.category.trim().length < 2)
      nextErrors.category = "Enter a service category with at least 2 characters.";
    if (!editing && (!Number.isFinite(form.defaultPrice) || form.defaultPrice < 0)) {
      nextErrors.defaultPrice = "Enter a valid default price of PHP 0 or more.";
    }
    if (
      !Number.isInteger(form.defaultDuration) ||
      form.defaultDuration < 15 ||
      form.defaultDuration > 480
    ) {
      nextErrors.defaultDuration = "Enter a whole duration from 15 to 480 minutes.";
    }
    if (Object.keys(nextErrors).length > 0) {
      setFormErrors(nextErrors);
      return false;
    }
    if (
      modelOverrides.some(
        (override) =>
          !override.brand.trim() ||
          !override.model.trim() ||
          !motorcycleBrands.includes(override.brand) ||
          !motorcycleModelsForBrand(override.brand).includes(override.model) ||
          !Number.isInteger(override.duration_minutes) ||
          override.duration_minutes < 15 ||
          override.duration_minutes > 480 ||
          (!override.id && (!Number.isFinite(override.price) || override.price < 0)),
      )
    ) {
      toast.error(
        "Select a catalog brand and model for every model override, with a valid duration and a price for new overrides.",
      );
      setFormErrors(nextErrors);
      return false;
    }
    setFormErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  }

  function requestSave() {
    if (validateForm()) setSaveConfirmationOpen(true);
  }

  function updateOverride(index: number, changes: Partial<ModelOverride>) {
    setModelOverrides((items) =>
      items.map((item, itemIndex) => (itemIndex === index ? { ...item, ...changes } : item)),
    );
  }

  function removeOverride(index: number) {
    setModelOverrides((items) => items.filter((_, itemIndex) => itemIndex !== index));
    setEditingOverride((current) => {
      if (current === null || current === index) return null;
      return current > index ? current - 1 : current;
    });
  }

  return (
    <div>
      <PageHeader
        title="Services"
        description="Manage service details and optional model overrides. Existing prices are managed in Price Management."
        action={
          <Button className="font-display uppercase" onClick={() => openEditor()}>
            <Plus /> Add service
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label className="text-sm">Category</Label>
          <Select value={filterCategory} onValueChange={setFilterCategory}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
              {distinctCategories.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {filterCategory !== ALL_CATEGORIES && (
          <Button
            size="sm"
            variant="outline"
            className="self-end whitespace-nowrap"
            onClick={() => setFilterCategory(ALL_CATEGORIES)}
          >
            <RotateCcw /> Reset
          </Button>
        )}
      </div>

      <Card className="max-w-7xl border-border/70 bg-card/60">
        <CardContent className="overflow-x-auto p-0">
          <Table className="admin-data-table admin-balanced-table w-full">
            <colgroup>
              <col style={{ width: "13%" }} />
              <col style={{ width: "37%" }} />
              <col style={{ width: "13%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "14%" }} />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">Date Created</TableHead>
                <TableHead className="text-left">Service</TableHead>
                <TableHead className="text-left">Category</TableHead>
                <TableHead className="text-center">Model Overrides</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="text-center" aria-label="Actions">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {services.data
                ?.filter(
                  (service) =>
                    filterCategory === ALL_CATEGORIES || service.category === filterCategory,
                )
                .map((service) => (
                  <TableRow key={service.id}>
                    <TableCell
                      data-label="Date Created"
                      className="whitespace-nowrap text-center text-xs text-muted-foreground"
                    >
                      {new Date(service.created_at).toLocaleDateString("en-PH", {
                        day: "2-digit",
                        month: "short",
                        year: "numeric",
                      })}
                    </TableCell>
                    <TableCell data-label="Service" className="align-middle">
                      <span className="block font-medium text-sm">{service.name}</span>
                      <ExpandableServiceDescription
                        description={service.description}
                        serviceName={service.name}
                      />
                    </TableCell>
                    <TableCell
                      data-label="Category"
                      className="text-xs text-muted-foreground capitalize"
                    >
                      {service.category}
                    </TableCell>
                    <TableCell
                      data-label="Model Overrides"
                      className="whitespace-nowrap text-center text-sm"
                    >
                      {overridesFor(service.id).length}
                    </TableCell>
                    <TableCell data-label="Status" className="whitespace-nowrap text-center">
                      <Badge
                        variant="outline"
                        className={`uppercase ${activeStatusTone(service.is_active)}`}
                      >
                        {service.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell data-label="Actions" className="align-middle text-center">
                      <DropdownMenu>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                              <Button
                                type="button"
                                size="icon"
                                variant="ghost"
                                aria-label={`More actions for ${service.name}`}
                              >
                                <EllipsisVertical className="size-4" />
                                <span className="sr-only">More actions</span>
                              </Button>
                            </DropdownMenuTrigger>
                          </TooltipTrigger>
                          <TooltipContent>More actions</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => setViewing(service)}>
                            <Eye /> View
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => openEditor(service)}>
                            <Pencil /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem onSelect={() => setArchiveTarget(service.id)}>
                            <Archive /> Archive
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
          {!services.isLoading && services.data?.length === 0 && (
            <p className="p-8 text-center text-sm text-muted-foreground">No services found.</p>
          )}
        </CardContent>
      </Card>

      <ServiceViewDialog
        service={viewing}
        overrides={viewing ? overridesFor(viewing.id) : []}
        onOpenChange={(nextOpen) => !nextOpen && setViewing(null)}
      />

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !save.isPending) closeEditor();
        }}
      >
        <DialogContent className="max-h-[90vh] max-w-6xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display uppercase">
              {editing ? "Edit service" : "New service"}
            </DialogTitle>
          </DialogHeader>

          <section className="space-y-3">
            <h3 className="font-display text-base uppercase">Service Details</h3>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Service Name</Label>
                <Input
                  value={form.name}
                  onChange={(event) => {
                    setForm({ ...form, name: event.target.value });
                    setFormErrors((current) => ({ ...current, name: undefined }));
                  }}
                  aria-invalid={!!formErrors.name}
                />
                <FieldError message={formErrors.name} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="service-category">Category</Label>
                <Select
                  value={isCustomCategory ? NEW_CATEGORY : form.category}
                  onValueChange={(value) => {
                    if (value === NEW_CATEGORY) {
                      setIsCustomCategory(true);
                      setForm({ ...form, category: "" });
                    } else {
                      setIsCustomCategory(false);
                      setForm({ ...form, category: value });
                    }
                    setFormErrors((current) => ({ ...current, category: undefined }));
                  }}
                >
                  <SelectTrigger id="service-category" aria-invalid={!!formErrors.category}>
                    <SelectValue placeholder="Select a category" />
                  </SelectTrigger>
                  <SelectContent>
                    {categoryOptions.map((category) => (
                      <SelectItem key={category} value={category}>
                        {category}
                      </SelectItem>
                    ))}
                    <SelectItem value={NEW_CATEGORY}>Add a new category…</SelectItem>
                  </SelectContent>
                </Select>
                {isCustomCategory && (
                  <Input
                    value={form.category}
                    onChange={(event) => {
                      setForm({ ...form, category: event.target.value });
                      setFormErrors((current) => ({ ...current, category: undefined }));
                    }}
                    placeholder="e.g. maintenance"
                    aria-label="New service category"
                  />
                )}
                <FieldError message={formErrors.category} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Textarea
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </div>
            <div className={editing ? "grid gap-3 md:grid-cols-2" : undefined}>
              <div className="space-y-1.5">
                <Label>Default Duration (minutes)</Label>
                <Input
                  type="number"
                  min="15"
                  max="480"
                  step="15"
                  value={Number.isFinite(form.defaultDuration) ? form.defaultDuration : ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    setForm({
                      ...form,
                      defaultDuration: value === "" ? Number.NaN : Number(value),
                    });
                    setFormErrors((current) => ({ ...current, defaultDuration: undefined }));
                  }}
                  aria-invalid={!!formErrors.defaultDuration}
                />
                <FieldError message={formErrors.defaultDuration} />
              </div>
              {editing && (
                <div className="rounded-md border border-primary/20 bg-primary/5 p-4">
                  <p className="text-sm font-medium">Status</p>
                  <div className="mt-2 flex items-center gap-3">
                    <Switch
                      id="service-active"
                      checked={form.isActive}
                      aria-label={`Service is ${form.isActive ? "active" : "inactive"}`}
                      onCheckedChange={(isActive) =>
                        setForm((current) => ({ ...current, isActive }))
                      }
                    />
                    <span
                      className={
                        form.isActive
                          ? "text-sm font-medium text-primary"
                          : "text-sm font-medium text-muted-foreground"
                      }
                    >
                      {form.isActive ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    Use the switch to control customer booking visibility. Inactive services are
                    hidden and cannot be selected for new bookings.
                  </p>
                </div>
              )}
            </div>
            {!editing && (
              <div className="space-y-1.5">
                <Label>Default Price</Label>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={Number.isFinite(form.defaultPrice) ? form.defaultPrice : ""}
                  onChange={(event) => {
                    const value = event.target.value;
                    setForm({
                      ...form,
                      defaultPrice: value === "" ? Number.NaN : Number(value),
                    });
                    setFormErrors((current) => ({ ...current, defaultPrice: undefined }));
                  }}
                  aria-invalid={!!formErrors.defaultPrice}
                />
                <FieldError message={formErrors.defaultPrice} />
              </div>
            )}
          </section>

          <ModelOverrideEditor
            overrides={modelOverrides}
            editingIndex={editingOverride}
            brands={motorcycleBrands}
            modelsForBrand={motorcycleModelsForBrand}
            catalogLoading={motorcycleCatalog.isLoading}
            onAdd={() => {
              setModelOverrides((items) => [
                ...items,
                { brand: "", model: "", duration_minutes: 60, price: 0 },
              ]);
              setEditingOverride(modelOverrides.length);
            }}
            onEdit={setEditingOverride}
            onDone={() => setEditingOverride(null)}
            onRemove={removeOverride}
            onChange={(index, changes) =>
              setModelOverrides((items) =>
                items.map((item, itemIndex) =>
                  itemIndex === index ? { ...item, ...changes } : item,
                ),
              )
            }
          />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeEditor} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="button" onClick={requestSave} disabled={save.isPending}>
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={saveConfirmationOpen} onOpenChange={setSaveConfirmationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Save service changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This will update the service details, default pricing, duration, and model overrides.
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
        recordLabel="service"
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

function ExpandableServiceDescription({
  description,
  serviceName,
}: {
  description: string | null;
  serviceName: string;
}) {
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);
  const details = description?.trim() || "No details provided.";

  useEffect(() => {
    const element = descriptionRef.current;
    if (!element) return;

    const checkOverflow = () => {
      // While expanded, retain the previous overflow result so the customer
      // can still collapse the row after reading the full description.
      if (!expanded) setCanExpand(element.scrollHeight > element.clientHeight + 1);
    };

    checkOverflow();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(checkOverflow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [details, expanded]);

  return (
    <div className="mt-0.5 max-w-md text-xs leading-relaxed text-muted-foreground">
      <p ref={descriptionRef} className={expanded ? "break-words" : "line-clamp-2 break-words"}>
        Details: {details}
      </p>
      {canExpand && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mt-0.5 h-auto p-0 text-xs"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} details for ${serviceName}`}
        >
          {expanded ? "See Less" : "See More"}
        </Button>
      )}
    </div>
  );
}

/* Legacy configuration view removed.
function ServiceViewDialog({
  service,
  configurations,
  overrides,
  onOpenChange,
}: {
  service: Service | null;
  configurations: ServiceConfiguration[];
  overrides: ModelOverride[];
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={Boolean(service)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl">
        <DialogHeader>
          <DialogTitle className="font-display uppercase">
            {service ? `${service.name} configurations` : "Service configurations"}
          </DialogTitle>
        </DialogHeader>
        <div className="overflow-x-auto">
          <Table className="admin-data-table admin-balanced-table min-w-[960px]">
            <colgroup>
              <col style={{ width: "14%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "16%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "35%" }} />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="text-left">CC Category</TableHead>
                <TableHead className="text-left">Fuel Type</TableHead>
                <TableHead className="text-left">Transmission</TableHead>
                <TableHead className="text-left">Duration</TableHead>
                <TableHead className="text-left">Price</TableHead>
                <TableHead className="text-left">Model Overrides</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {configurations.map((configuration, index) => (
                <TableRow key={configuration.id ?? index}>
                  <TableCell data-label="CC Category">{configuration.cc_category}</TableCell>
                  <TableCell data-label="Fuel Type">{configuration.fuel_type}</TableCell>
                  <TableCell data-label="Transmission">{configuration.transmission}</TableCell>
                  <TableCell data-label="Duration">{configuration.duration_minutes} min</TableCell>
                  <TableCell data-label="Price" className="text-primary">
                    {formatPHP(configuration.price)}
                  </TableCell>
                  <TableCell data-label="Model Overrides" className="min-w-60">
                    {overrides.length > 0 ? (
                      <div className="space-y-2">
                        {overrides.map((override, overrideIndex) => (
                          <dl
                            key={override.id ?? overrideIndex}
                            className="grid grid-cols-2 gap-x-3 gap-y-0.5 rounded border border-border/60 p-2 text-xs"
                          >
                            <dt className="text-muted-foreground">Brand</dt>
                            <dd>{override.brand}</dd>
                            <dt className="text-muted-foreground">Model</dt>
                            <dd>{modelLabel(override.brand, override.model)}</dd>
                            <dt className="text-muted-foreground">Duration</dt>
                            <dd>{override.duration_minutes} min</dd>
                            <dt className="text-muted-foreground">Price</dt>
                            <dd className="text-primary">{formatPHP(override.price)}</dd>
                          </dl>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">No overrides</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
*/

function ServiceViewDialog({
  service,
  overrides,
  onOpenChange,
}: {
  service: Service | null;
  overrides: ModelOverride[];
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={Boolean(service)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="font-display uppercase">View service</DialogTitle>
        </DialogHeader>
        <div className="space-y-6">
          <section className="rounded-lg border border-border/70 bg-muted/20 p-4 sm:p-5">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Service Name
            </p>
            <p className="mt-1 font-display text-xl uppercase">{service?.name ?? "Service"}</p>

            <div className="mt-5 grid gap-4 border-t border-border/70 pt-4 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Default Duration
                </p>
                <p className="mt-1 text-sm font-medium">{service?.duration_minutes ?? 0} minutes</p>
              </div>
              <div>
                <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Default Price
                </p>
                <p className="mt-1 text-sm font-medium text-primary">
                  {formatPHP(service?.price ?? 0)}
                </p>
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <div>
              <h3 className="font-display text-base uppercase">Model Overrides</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Custom duration and price details for specific motorcycle models.
              </p>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border/70">
              <Table className="admin-data-table admin-balanced-table min-w-[640px]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Brand</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-center">Duration</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overrides.map((override, index) => (
                    <TableRow key={override.id ?? index}>
                      <TableCell data-label="Brand">{override.brand}</TableCell>
                      <TableCell data-label="Model">
                        {modelLabel(override.brand, override.model)}
                      </TableCell>
                      <TableCell data-label="Duration" className="text-center">
                        {override.duration_minutes} min
                      </TableCell>
                      <TableCell data-label="Price" className="text-right text-primary">
                        {formatPHP(override.price)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {overrides.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                        No model overrides configured.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </section>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* Legacy configuration editor removed from the Services workflow.
function ConfigurationEditor({
  configurations,
  editingIndex,
  onAdd,
  onEdit,
  onDone,
  onRemove,
  onChange,
}: {
  configurations: ServiceConfiguration[];
  editingIndex: number | null;
  onAdd: () => void;
  onEdit: (index: number) => void;
  onDone: () => void;
  onRemove: (index: number) => void;
  onChange: (index: number, changes: Partial<ServiceConfiguration>) => void;
}) {
  return (
    <section className="space-y-3 border-t border-border/70 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-base uppercase">Service Configuration</h3>
        <Button type="button" size="sm" variant="outline" onClick={onAdd}>
          <Plus className="h-4 w-4" /> Add Rule
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border border-border/70">
        <Table className="admin-data-table admin-balanced-table min-w-[900px]">
          <colgroup>
            <col style={{ width: "16%" }} />
            <col style={{ width: "15%" }} />
            <col style={{ width: "19%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "24%" }} />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead className="text-left">CC Category</TableHead>
              <TableHead className="text-center">Fuel</TableHead>
              <TableHead className="text-center">Transmission</TableHead>
              <TableHead className="text-center">Duration</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-center">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {configurations.map((configuration, index) => (
              <ConfigurationRow
                key={configuration.id ?? index}
                configuration={configuration}
                editing={editingIndex === index}
                onChange={(changes) => onChange(index, changes)}
                onEdit={() => (editingIndex === index ? onDone() : onEdit(index))}
                onRemove={() => onRemove(index)}
              />
            ))}
            {configurations.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                  No configuration rules. Add Rule to create one.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

function ConfigurationRow({
  configuration,
  editing,
  onChange,
  onEdit,
  onRemove,
}: {
  configuration: ServiceConfiguration;
  editing: boolean;
  onChange: (changes: Partial<ServiceConfiguration>) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <TableRow>
      <TableCell data-label="CC Category">
        {editing ? (
          <Select
            value={configuration.cc_category}
            onValueChange={(cc_category) => onChange({ cc_category })}
          >
            <SelectTrigger className="w-full" aria-label="CC category">
              <SelectValue placeholder="Select category" />
            </SelectTrigger>
            <SelectContent>
              {CC_OPTIONS.map((cc) => (
                <SelectItem key={cc} value={cc}>
                  {cc}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          configuration.cc_category
        )}
      </TableCell>
      <TableCell data-label="Fuel">
        {editing ? (
          <Select
            value={configuration.fuel_type}
            onValueChange={(fuel_type) => onChange({ fuel_type })}
          >
            <SelectTrigger className="w-full" aria-label="Fuel type">
              <SelectValue placeholder="Select fuel" />
            </SelectTrigger>
            <SelectContent>
              {FUEL_OPTIONS.map((fuel) => (
                <SelectItem key={fuel} value={fuel}>
                  {fuel}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          configuration.fuel_type
        )}
      </TableCell>
      <TableCell data-label="Transmission">
        {editing ? (
          <Select
            value={configuration.transmission}
            onValueChange={(transmission) => onChange({ transmission })}
          >
            <SelectTrigger className="w-full" aria-label="Transmission">
              <SelectValue placeholder="Select transmission" />
            </SelectTrigger>
            <SelectContent>
              {TRANSMISSION_OPTIONS.map((transmission) => (
                <SelectItem key={transmission} value={transmission}>
                  {transmission}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          configuration.transmission
        )}
      </TableCell>
      <TableCell data-label="Duration">
        {editing ? (
          <Input
            type="number"
            min="15"
            max="480"
            value={configuration.duration_minutes}
            onChange={(event) => onChange({ duration_minutes: Number(event.target.value) })}
            aria-label="Duration in minutes"
          />
        ) : (
          `${configuration.duration_minutes} min`
        )}
      </TableCell>
      <TableCell data-label="Price">
        {editing ? (
          <Input
            type="number"
            min="0"
            step="0.01"
            value={configuration.price}
            onChange={(event) => onChange({ price: Number(event.target.value) })}
            aria-label="Price"
          />
        ) : (
          formatPHP(configuration.price)
        )}
      </TableCell>
      <TableCell data-label="Action" className="align-middle">
        <div className="flex items-center gap-1 whitespace-nowrap">
          <Button type="button" size="sm" variant="ghost" onClick={onEdit}>
            {editing ? "Done" : "Edit"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}
*/

function ModelOverrideEditor({
  overrides,
  editingIndex,
  brands,
  modelsForBrand,
  catalogLoading,
  onAdd,
  onEdit,
  onDone,
  onRemove,
  onChange,
}: {
  overrides: ModelOverride[];
  editingIndex: number | null;
  brands: string[];
  modelsForBrand: (brand: string) => string[];
  catalogLoading: boolean;
  onAdd: () => void;
  onEdit: (index: number) => void;
  onDone: () => void;
  onRemove: (index: number) => void;
  onChange: (index: number, changes: Partial<ModelOverride>) => void;
}) {
  const hasNewOverride = overrides.some((override) => !override.id);
  return (
    <section className="space-y-3 border-t border-border/70 pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-base uppercase">Model Overrides</h3>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onAdd}
          disabled={catalogLoading || brands.length === 0}
        >
          <Plus className="h-4 w-4" /> Add Override
        </Button>
      </div>
      <div className="overflow-x-auto rounded-md border border-border/70">
        <Table className="admin-data-table admin-balanced-table w-full min-w-[680px]">
          <colgroup>
            <col style={{ width: hasNewOverride ? "22%" : "27%" }} />
            <col style={{ width: hasNewOverride ? "25%" : "31%" }} />
            <col style={{ width: hasNewOverride ? "17%" : "20%" }} />
            {hasNewOverride && <col style={{ width: "16%" }} />}
            <col style={{ width: hasNewOverride ? "20%" : "22%" }} />
          </colgroup>
          <TableHeader>
            <TableRow>
              <TableHead className="text-left">Brand</TableHead>
              <TableHead className="text-left">Model</TableHead>
              <TableHead className="text-center">Duration</TableHead>
              {hasNewOverride && <TableHead className="text-right">Price (new)</TableHead>}
              <TableHead className="text-center">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {overrides.map((override, index) => (
              <ModelOverrideRow
                key={override.id ?? index}
                override={override}
                editing={editingIndex === index}
                brands={brands}
                modelsForBrand={modelsForBrand}
                catalogLoading={catalogLoading}
                onChange={(changes) => onChange(index, changes)}
                onEdit={() => (editingIndex === index ? onDone() : onEdit(index))}
                onRemove={() => onRemove(index)}
                showPrice={hasNewOverride}
              />
            ))}
            {overrides.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  No model overrides. Add Override to create one.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {!catalogLoading && brands.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Add an active motorcycle to the Motorcycle Catalog before creating a model override.
        </p>
      )}
    </section>
  );
}

function ModelOverrideRow({
  override,
  editing,
  brands,
  modelsForBrand,
  catalogLoading,
  onChange,
  onEdit,
  onRemove,
  showPrice,
}: {
  override: ModelOverride;
  editing: boolean;
  brands: string[];
  modelsForBrand: (brand: string) => string[];
  catalogLoading: boolean;
  onChange: (changes: Partial<ModelOverride>) => void;
  onEdit: () => void;
  onRemove: () => void;
  showPrice: boolean;
}) {
  return (
    <TableRow>
      <TableCell data-label="Brand">
        {editing ? (
          <Select value={override.brand} onValueChange={(brand) => onChange({ brand, model: "" })}>
            <SelectTrigger className="w-full" aria-label="Motorcycle brand">
              <SelectValue placeholder="Select brand" />
            </SelectTrigger>
            <SelectContent>
              {brands.map((brand) => (
                <SelectItem key={brand} value={brand}>
                  {brand}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          override.brand
        )}
      </TableCell>
      <TableCell data-label="Model">
        {editing ? (
          <Select
            value={override.model}
            onValueChange={(model) => onChange({ model })}
            disabled={
              catalogLoading || !override.brand || modelsForBrand(override.brand).length === 0
            }
          >
            <SelectTrigger className="w-full" aria-label="Motorcycle model">
              <SelectValue placeholder={override.brand ? "Select model" : "Select a brand first"} />
            </SelectTrigger>
            <SelectContent>
              {modelsForBrand(override.brand).map((model) => (
                <SelectItem key={model} value={model}>
                  {modelLabel(override.brand, model)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          modelLabel(override.brand, override.model)
        )}
      </TableCell>
      <TableCell data-label="Duration">
        {editing ? (
          <Input
            type="number"
            min="15"
            max="480"
            value={override.duration_minutes}
            onChange={(event) => onChange({ duration_minutes: Number(event.target.value) })}
            aria-label="Duration in minutes"
          />
        ) : (
          `${override.duration_minutes} min`
        )}
      </TableCell>
      {showPrice && (
        <TableCell data-label="Price (new)" className="text-right">
          {!override.id && editing ? (
            <Input
              className="ml-auto w-full max-w-32 text-right"
              type="number"
              min="0"
              step="0.01"
              value={override.price}
              onChange={(event) => onChange({ price: Number(event.target.value) })}
              aria-label="Price for new model override"
            />
          ) : null}
        </TableCell>
      )}
      <TableCell data-label="Action" className="align-middle">
        <div className="flex items-center gap-1 whitespace-nowrap">
          <Button type="button" size="sm" variant="ghost" onClick={onEdit}>
            {editing ? "Done" : "Edit"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={onRemove}
          >
            <Trash2 className="h-4 w-4" /> Delete
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function modelLabel(brand: string, model: string) {
  const brandPrefix = `${brand.trim()} `;
  return model.startsWith(brandPrefix) ? model.slice(brandPrefix.length) : model;
}
