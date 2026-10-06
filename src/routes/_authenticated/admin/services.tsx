import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Archive, EllipsisVertical, Eye, Pencil, Plus, RotateCcw } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FieldError } from "@/components/ui/field-error";
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
  large_bike_price: number | string | null;
  large_bike_duration_minutes: number | null;
  is_active: boolean;
  is_archived: boolean;
  category: string;
  created_at: string;
};

type ServiceForm = {
  name: string;
  category: string;
  description: string;
  defaultPrice: number;
  defaultDuration: number;
  largeBikeEnabled: boolean;
  largeBikePrice: number;
  largeBikeDuration: number;
  isActive: boolean;
};

type FormErrors = Partial<
  Record<
    "name" | "category" | "description" | "defaultPrice" | "defaultDuration" | "largeBike",
    string
  >
>;

const blank: ServiceForm = {
  name: "",
  category: "",
  description: "",
  defaultPrice: Number.NaN,
  defaultDuration: Number.NaN,
  largeBikeEnabled: false,
  largeBikePrice: Number.NaN,
  largeBikeDuration: Number.NaN,
  isActive: true,
};
const ALL_CATEGORIES = "__all_categories__";

function ServicesAdmin() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);
  const [viewing, setViewing] = useState<Service | null>(null);
  const [form, setForm] = useState<ServiceForm>({ ...blank });
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [filterCategory, setFilterCategory] = useState(ALL_CATEGORIES);
  const [archiveTarget, setArchiveTarget] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
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

  const categories = useMemo(
    () =>
      Array.from(
        new Set((services.data ?? []).map((service) => service.category).filter(Boolean)),
      ).sort((left, right) => left.localeCompare(right)),
    [services.data],
  );

  const save = useMutation({
    mutationFn: async () => {
      const largeBikeFields = form.largeBikeEnabled
        ? {
            large_bike_price: form.largeBikePrice,
            large_bike_duration_minutes: form.largeBikeDuration,
          }
        : { large_bike_price: null, large_bike_duration_minutes: null };
      const payload = {
        name: form.name.trim(),
        category: form.category.trim().toLowerCase(),
        description: form.description.trim(),
        duration_minutes: form.defaultDuration,
        is_active: form.isActive,
        ...largeBikeFields,
      };
      const { error } = editing
        ? await supabase.from("services").update(payload).eq("id", editing.id)
        : await supabase.from("services").insert({ ...payload, price: form.defaultPrice });
      if (error) throw error;
    },
    onSuccess: () => {
      setSaveConfirmationOpen(false);
      closeEditor();
      queryClient.invalidateQueries({ queryKey: ["admin-services"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["services"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["prices"], exact: false });
    },
    onError: (error: Error) => {
      console.error("Could not save service:", error);
      setSaveConfirmationOpen(false);
      setFormErrors({ name: "Could not save this service. Please try again." });
    },
  });

  const archive = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("services").update({ is_archived: true }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      setArchiveError(null);
      queryClient.invalidateQueries({ queryKey: ["admin-services"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["archived-services"], exact: false });
    },
    onError: () => setArchiveError("Could not archive this service. Please try again."),
  });

  function clearError(field: keyof FormErrors) {
    setFormErrors((current) => {
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function closeEditor() {
    setOpen(false);
    setEditing(null);
    setForm({ ...blank });
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
            defaultDuration: service.duration_minutes,
            largeBikeEnabled:
              service.large_bike_price !== null && service.large_bike_duration_minutes !== null,
            largeBikePrice: Number(service.large_bike_price ?? Number.NaN),
            largeBikeDuration: service.large_bike_duration_minutes ?? Number.NaN,
            isActive: service.is_active,
          }
        : { ...blank },
    );
    setFormErrors({});
    setOpen(true);
  }

  function validateForm() {
    const errors: FormErrors = {};
    if (form.name.trim().length < 2)
      errors.name = "Enter a service name with at least 2 characters.";
    if (form.category.trim().length < 2)
      errors.category = "Enter a service category with at least 2 characters.";
    if (!form.description.trim()) errors.description = "Service details are required.";
    if (!Number.isFinite(form.defaultPrice) || form.defaultPrice < 0)
      errors.defaultPrice = "Enter a valid Small Bike price of PHP 0 or more.";
    if (
      !Number.isInteger(form.defaultDuration) ||
      form.defaultDuration < 15 ||
      form.defaultDuration > 480
    )
      errors.defaultDuration = "Enter a whole duration from 15 to 480 minutes.";
    if (
      form.largeBikeEnabled &&
      (!Number.isFinite(form.largeBikePrice) ||
        form.largeBikePrice <= form.defaultPrice ||
        !Number.isInteger(form.largeBikeDuration) ||
        form.largeBikeDuration < form.defaultDuration ||
        form.largeBikeDuration > 480)
    ) {
      errors.largeBike =
        "Large Bike price must be higher than the Small Bike price, and duration must be from the Small Bike duration to 480 minutes.";
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }

  const filteredServices = (services.data ?? []).filter(
    (service) => filterCategory === ALL_CATEGORIES || service.category === filterCategory,
  );

  return (
    <div>
      <PageHeader
        title="Services"
        description="Manage Small Bike defaults and optional Large Bike pricing and duration."
        action={
          <Button className="font-display uppercase" onClick={() => openEditor()}>
            <Plus /> Add service
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
          <Label className="text-sm">Category</Label>
          <Select value={filterCategory} onValueChange={setFilterCategory}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
              {categories.map((category) => (
                <SelectItem key={category} value={category}>
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {filterCategory !== ALL_CATEGORIES && (
          <Button size="sm" variant="outline" onClick={() => setFilterCategory(ALL_CATEGORIES)}>
            <RotateCcw /> Reset
          </Button>
        )}
      </div>

      <Card className="max-w-7xl border-border/70 bg-card/60">
        <CardContent className="overflow-x-auto p-0">
          <Table className="admin-data-table admin-balanced-table w-full">
            <TableHeader>
              <TableRow>
                <TableHead className="text-center">Date Created</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-center">Status</TableHead>
                <TableHead className="text-center">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredServices.map((service) => (
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
                  <TableCell data-label="Service">
                    <p className="font-medium">{service.name}</p>
                    <ExpandableServiceDescription
                      description={service.description}
                      serviceName={service.name}
                    />
                  </TableCell>
                  <TableCell data-label="Category" className="capitalize">
                    {service.category}
                  </TableCell>
                  <TableCell data-label="Status" className="text-center">
                    <Badge
                      variant="outline"
                      className={`uppercase ${activeStatusTone(service.is_active)}`}
                    >
                      {service.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell data-label="Actions" className="text-center">
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
          {!services.isLoading && filteredServices.length === 0 && (
            <p className="p-8 text-center text-sm text-muted-foreground">No services found.</p>
          )}
        </CardContent>
      </Card>

      <ServiceViewDialog service={viewing} onOpenChange={(isOpen) => !isOpen && setViewing(null)} />
      <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !save.isPending && closeEditor()}>
        <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-display uppercase">
              {editing ? "Edit service" : "New service"}
            </DialogTitle>
          </DialogHeader>
          <section className="space-y-4">
            <h3 className="font-display text-base uppercase">Service Details</h3>
            <div className="grid gap-3 md:grid-cols-2">
              <FormField label="Service Name" error={formErrors.name}>
                <Input
                  value={form.name}
                  onChange={(event) => {
                    setForm({ ...form, name: event.target.value });
                    clearError("name");
                  }}
                  aria-invalid={Boolean(formErrors.name)}
                />
              </FormField>
              <FormField label="Category" error={formErrors.category}>
                <Input
                  value={form.category}
                  list="service-category-options"
                  onChange={(event) => {
                    setForm({ ...form, category: event.target.value });
                    clearError("category");
                  }}
                  aria-invalid={Boolean(formErrors.category)}
                />
                <datalist id="service-category-options">
                  {categories.map((category) => (
                    <option key={category} value={category} />
                  ))}
                </datalist>
              </FormField>
            </div>
            <FormField label="Details" error={formErrors.description}>
              <Textarea
                value={form.description}
                onChange={(event) => {
                  setForm({ ...form, description: event.target.value });
                  clearError("description");
                }}
                aria-invalid={Boolean(formErrors.description)}
              />
            </FormField>
            <div className="grid gap-3 md:grid-cols-2">
              <FormField
                label="Small Bike Default Duration (minutes)"
                error={formErrors.defaultDuration}
              >
                <Input
                  type="number"
                  min="15"
                  max="480"
                  step="15"
                  value={Number.isFinite(form.defaultDuration) ? form.defaultDuration : ""}
                  onChange={(event) => {
                    setForm({
                      ...form,
                      defaultDuration:
                        event.target.value === "" ? Number.NaN : Number(event.target.value),
                    });
                    clearError("defaultDuration");
                  }}
                  aria-invalid={Boolean(formErrors.defaultDuration)}
                />
              </FormField>
              {!editing && (
                <FormField label="Small Bike Default Price" error={formErrors.defaultPrice}>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={Number.isFinite(form.defaultPrice) ? form.defaultPrice : ""}
                    onChange={(event) => {
                      setForm({
                        ...form,
                        defaultPrice:
                          event.target.value === "" ? Number.NaN : Number(event.target.value),
                      });
                      clearError("defaultPrice");
                    }}
                    aria-invalid={Boolean(formErrors.defaultPrice)}
                  />
                </FormField>
              )}
              {editing && (
                <div className="rounded-md border border-primary/20 bg-primary/5 p-4">
                  <p className="text-sm font-medium">Status</p>
                  <div className="mt-2 flex items-center gap-3">
                    <Switch
                      checked={form.isActive}
                      onCheckedChange={(isActive) =>
                        setForm((current) => ({ ...current, isActive }))
                      }
                    />
                    <span className="text-sm">{form.isActive ? "Active" : "Inactive"}</span>
                  </div>
                </div>
              )}
            </div>
          </section>
          <section className="space-y-3 border-t border-border/70 pt-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="font-display text-base uppercase">Large Bike Configuration</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  For motorcycles at 126cc and above.
                </p>
              </div>
              {!form.largeBikeEnabled && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setForm((current) => ({
                      ...current,
                      largeBikeEnabled: true,
                      largeBikePrice: Number.NaN,
                      largeBikeDuration: current.defaultDuration,
                    }))
                  }
                >
                  <Plus /> Add
                </Button>
              )}
            </div>
            {form.largeBikeEnabled && (
              <div className="rounded-lg border border-border/70 p-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <FormField label="Large Bike Price" error={formErrors.largeBike}>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={Number.isFinite(form.largeBikePrice) ? form.largeBikePrice : ""}
                      onChange={(event) => {
                        setForm({
                          ...form,
                          largeBikePrice:
                            event.target.value === "" ? Number.NaN : Number(event.target.value),
                        });
                        clearError("largeBike");
                      }}
                    />
                  </FormField>
                  <FormField label="Large Bike Duration (minutes)" error={formErrors.largeBike}>
                    <Input
                      type="number"
                      min="15"
                      max="480"
                      step="15"
                      value={Number.isFinite(form.largeBikeDuration) ? form.largeBikeDuration : ""}
                      onChange={(event) => {
                        setForm({
                          ...form,
                          largeBikeDuration:
                            event.target.value === "" ? Number.NaN : Number(event.target.value),
                        });
                        clearError("largeBike");
                      }}
                    />
                  </FormField>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="mt-3 text-destructive hover:text-destructive"
                  onClick={() => {
                    setForm((current) => ({
                      ...current,
                      largeBikeEnabled: false,
                      largeBikePrice: Number.NaN,
                      largeBikeDuration: Number.NaN,
                    }));
                    clearError("largeBike");
                  }}
                >
                  Remove
                </Button>
              </div>
            )}
          </section>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeEditor} disabled={save.isPending}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => validateForm() && setSaveConfirmationOpen(true)}
              disabled={save.isPending}
            >
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
              This will update the Small Bike defaults and any Large Bike configuration.
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
        onOpenChange={(isOpen) => !isOpen && setArchiveTarget(null)}
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

function FormField({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      <FieldError message={error} />
    </div>
  );
}

function ServiceViewDialog({
  service,
  onOpenChange,
}: {
  service: Service | null;
  onOpenChange: (open: boolean) => void;
}) {
  const hasLargeBikeConfiguration =
    service?.large_bike_price !== null &&
    service?.large_bike_price !== undefined &&
    service?.large_bike_duration_minutes !== null &&
    service?.large_bike_duration_minutes !== undefined;
  return (
    <Dialog open={Boolean(service)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display uppercase">View service</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <section className="rounded-lg border border-border/70 bg-muted/20 p-4">
            <p className="text-xs tracking-wide text-muted-foreground uppercase">Service Name</p>
            <p className="mt-1 font-display text-xl uppercase">{service?.name}</p>
            <p className="mt-3 text-sm text-muted-foreground">
              {service?.description || "No details provided."}
            </p>
          </section>
          <section className="grid gap-3 sm:grid-cols-2">
            <PricingCard
              title="Small Bike (125cc and below)"
              price={service?.price}
              duration={service?.duration_minutes}
            />
            {hasLargeBikeConfiguration ? (
              <PricingCard
                title="Large Bike (126cc and above)"
                price={service?.large_bike_price}
                duration={service?.large_bike_duration_minutes}
              />
            ) : (
              <div className="rounded-lg border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                No Large Bike configuration.
              </div>
            )}
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

function PricingCard({
  title,
  price,
  duration,
}: {
  title: string;
  price: number | string | null | undefined;
  duration: number | null | undefined;
}) {
  return (
    <div className="rounded-lg border border-border/70 p-4">
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{title}</p>
      <p className="mt-3 text-sm">
        Duration: <span className="font-medium">{duration ?? 0} minutes</span>
      </p>
      <p className="mt-1 text-sm">
        Price: <span className="font-medium text-primary">{formatPHP(Number(price ?? 0))}</span>
      </p>
    </div>
  );
}
