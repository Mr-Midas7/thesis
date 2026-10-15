import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Archive,
  CircleAlert,
  Clock,
  EllipsisVertical,
  Eye,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Tags,
  Wrench,
} from "lucide-react";
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
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
import { Skeleton } from "@/components/ui/skeleton";
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
import { cn } from "@/lib/utils";

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

type StatusFilter = "all" | "active" | "inactive";

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
  const [saveError, setSaveError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filterCategory, setFilterCategory] = useState(ALL_CATEGORIES);
  const [filterStatus, setFilterStatus] = useState<StatusFilter>("all");
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
      setSaveError("Could not save this service. Please review the details and try again.");
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
    setSaveError(null);
  }

  function closeEditor() {
    setOpen(false);
    setEditing(null);
    setForm({ ...blank });
    setFormErrors({});
    setSaveError(null);
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
    setSaveError(null);
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

  const normalizedSearch = search.trim().toLowerCase();
  const filteredServices = (services.data ?? []).filter(
    (service) =>
      (filterCategory === ALL_CATEGORIES || service.category === filterCategory) &&
      (filterStatus === "all" || service.is_active === (filterStatus === "active")) &&
      (!normalizedSearch ||
        service.name.toLowerCase().includes(normalizedSearch) ||
        (service.description ?? "").toLowerCase().includes(normalizedSearch)),
  );
  const hasFilters =
    Boolean(normalizedSearch) || filterCategory !== ALL_CATEGORIES || filterStatus !== "all";
  const activeCount = (services.data ?? []).filter((service) => service.is_active).length;
  const inactiveCount = (services.data ?? []).length - activeCount;

  function resetFilters() {
    setSearch("");
    setFilterCategory(ALL_CATEGORIES);
    setFilterStatus("all");
  }

  const actions = (service: Service) => (
    <div className="flex items-center justify-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => openEditor(service)}
        aria-label={`Edit ${service.name}`}
      >
        <Pencil /> Edit
      </Button>
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
            <Eye /> View details
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/admin/prices">
              <Tags /> Manage prices
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => setArchiveTarget(service.id)}
            className="text-destructive focus:text-destructive"
          >
            <Archive /> Archive
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-7xl">
      <PageHeader
        title="Services"
        description="Manage the service menu, Small Bike defaults, and optional Large Bike pricing and duration."
        action={
          <Button className="font-display uppercase" onClick={() => openEditor()}>
            <Plus /> Add service
          </Button>
        }
      />
      {archiveError && (
        <p
          role="alert"
          className="mb-4 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          <CircleAlert className="size-4 shrink-0" aria-hidden="true" /> {archiveError}
        </p>
      )}

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
        <div className="relative min-w-0 lg:w-72">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search services or details"
            aria-label="Search services by name or details"
            className="pl-9"
          />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-center">
          <Select value={filterCategory} onValueChange={setFilterCategory}>
            <SelectTrigger aria-label="Filter by category" className="w-full capitalize sm:w-48">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
              {categories.map((category) => (
                <SelectItem key={category} value={category} className="capitalize">
                  {category}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filterStatus}
            onValueChange={(value) => setFilterStatus(value as StatusFilter)}
          >
            <SelectTrigger aria-label="Filter by status" className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active ({activeCount})</SelectItem>
              <SelectItem value="inactive">Inactive ({inactiveCount})</SelectItem>
            </SelectContent>
          </Select>
          {hasFilters && (
            <Button variant="outline" onClick={resetFilters} className="col-span-2 sm:col-span-1">
              <RotateCcw /> Reset filters
            </Button>
          )}
        </div>
        {services.data && (
          <p className="text-sm text-muted-foreground lg:ml-auto">
            Showing {filteredServices.length} of {services.data.length} services
          </p>
        )}
      </div>

      <Card className="overflow-hidden border-border/70 bg-card/60">
        <CardContent className="p-0">
          {filteredServices.length > 0 && (
            <>
              {/* Phones and tablets: one card per service, so nothing scrolls
                  sideways next to the admin sidebar. */}
              <ul className="divide-y divide-border/70 lg:hidden">
                {filteredServices.map((service) => (
                  <li
                    key={service.id}
                    className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-6"
                  >
                    <div className="min-w-0 space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <ServiceIdentity service={service} />
                        <span className="sm:hidden">
                          <StatusBadge active={service.is_active} />
                        </span>
                      </div>
                      <ExpandableServiceDescription
                        description={service.description}
                        serviceName={service.name}
                      />
                      <ServicePricing service={service} layout="inline" />
                    </div>
                    <div className="flex items-center justify-between gap-2 sm:flex-col sm:items-end sm:justify-start">
                      <span className="hidden sm:block">
                        <StatusBadge active={service.is_active} />
                      </span>
                      {actions(service)}
                    </div>
                  </li>
                ))}
              </ul>

              {/* Laptops and desktops: a compact table. */}
              <Table className="hidden w-full table-fixed lg:table">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">Service</TableHead>
                    <TableHead className="w-52">Pricing</TableHead>
                    <TableHead className="w-28 text-center">Status</TableHead>
                    <TableHead className="w-40 pr-5 text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredServices.map((service) => (
                    <TableRow key={service.id} className="align-top">
                      <TableCell className="py-3 pl-5">
                        <ServiceIdentity service={service} />
                        <ExpandableServiceDescription
                          description={service.description}
                          serviceName={service.name}
                        />
                      </TableCell>
                      <TableCell className="py-3">
                        <ServicePricing service={service} layout="stacked" />
                      </TableCell>
                      <TableCell className="py-3 text-center">
                        <StatusBadge active={service.is_active} />
                      </TableCell>
                      <TableCell className="py-3 pr-5">{actions(service)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}

          {services.isLoading && (
            <div className="divide-y divide-border/70" aria-label="Loading services">
              {Array.from({ length: 5 }, (_, index) => (
                <div key={index} className="space-y-2 p-4">
                  <Skeleton className="h-4 w-48 max-w-full" />
                  <Skeleton className="h-3 w-72 max-w-full" />
                </div>
              ))}
            </div>
          )}
          {services.isError && (
            <div className="px-4 py-10 text-center">
              <p className="inline-flex items-center gap-2 text-sm text-destructive">
                <CircleAlert className="size-4" aria-hidden="true" /> Could not load services.
              </p>
              <div className="mt-3">
                <Button size="sm" variant="outline" onClick={() => void services.refetch()}>
                  Try again
                </Button>
              </div>
            </div>
          )}
          {services.isSuccess && filteredServices.length === 0 && (
            <div className="px-4 py-12 text-center">
              <Wrench className="mx-auto size-8 text-muted-foreground/60" aria-hidden="true" />
              <p className="mt-3 text-sm font-medium">
                {hasFilters ? "No services match your filters." : "No services yet."}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {hasFilters
                  ? "Try a different search, category, or status."
                  : "Add your first service to show it on the booking page."}
              </p>
              <div className="mt-4">
                {hasFilters ? (
                  <Button size="sm" variant="outline" onClick={resetFilters}>
                    <RotateCcw /> Reset filters
                  </Button>
                ) : (
                  <Button size="sm" onClick={() => openEditor()}>
                    <Plus /> Add service
                  </Button>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ServiceViewDialog
        service={viewing}
        onOpenChange={(isOpen) => !isOpen && setViewing(null)}
        onEdit={(service) => {
          setViewing(null);
          openEditor(service);
        }}
      />

      <Dialog open={open} onOpenChange={(isOpen) => !isOpen && !save.isPending && closeEditor()}>
        <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="font-display text-2xl uppercase">
              {editing ? "Edit service" : "Add service"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "Update the service details, Small Bike duration, status, and Large Bike configuration."
                : "Fill in the details customers see when booking, then set the Small Bike default price and duration."}
            </DialogDescription>
          </DialogHeader>

          <form
            noValidate
            className="space-y-6"
            onSubmit={(event) => {
              event.preventDefault();
              if (validateForm()) setSaveConfirmationOpen(true);
            }}
          >
            <FormSection title="Service details">
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField id="service-name" label="Service name" error={formErrors.name}>
                  <Input
                    id="service-name"
                    value={form.name}
                    placeholder="e.g. Change Oil"
                    onChange={(event) => {
                      setForm({ ...form, name: event.target.value });
                      clearError("name");
                    }}
                    aria-invalid={Boolean(formErrors.name)}
                  />
                </FormField>
                <FormField
                  id="service-category"
                  label="Category"
                  hint="Pick an existing category or type a new one."
                  error={formErrors.category}
                >
                  <Input
                    id="service-category"
                    value={form.category}
                    list="service-category-options"
                    placeholder="e.g. maintenance"
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
              <FormField
                id="service-description"
                label="Details"
                hint="Shown to customers on the services page. Describe what the service includes."
                error={formErrors.description}
              >
                <Textarea
                  id="service-description"
                  rows={4}
                  value={form.description}
                  onChange={(event) => {
                    setForm({ ...form, description: event.target.value });
                    clearError("description");
                  }}
                  aria-invalid={Boolean(formErrors.description)}
                />
              </FormField>
            </FormSection>

            <FormSection
              title="Small Bike (125cc and below)"
              description="The default price and service time used for most motorcycles."
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  id="service-small-duration"
                  label="Duration (minutes)"
                  hint="15 to 480 minutes."
                  error={formErrors.defaultDuration}
                >
                  <Input
                    id="service-small-duration"
                    type="number"
                    inputMode="numeric"
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
                {editing ? (
                  <div className="rounded-lg border border-border/70 bg-muted/30 p-3">
                    <p className="text-xs tracking-wide text-muted-foreground uppercase">
                      Current price
                    </p>
                    <p className="font-display text-2xl text-primary tabular-nums">
                      {formatPHP(form.defaultPrice)}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Change prices in{" "}
                      <Link
                        to="/admin/prices"
                        className="font-medium text-primary underline underline-offset-2"
                      >
                        Prices Management
                      </Link>{" "}
                      so each change is recorded with a reason.
                    </p>
                  </div>
                ) : (
                  <FormField id="service-small-price" label="Price" error={formErrors.defaultPrice}>
                    <PesoInput
                      id="service-small-price"
                      value={form.defaultPrice}
                      invalid={Boolean(formErrors.defaultPrice)}
                      onChange={(defaultPrice) => {
                        setForm({ ...form, defaultPrice });
                        clearError("defaultPrice");
                      }}
                    />
                  </FormField>
                )}
              </div>
            </FormSection>

            <FormSection
              title="Large Bike (126cc and above)"
              description="Offer a separate price and service time for larger motorcycles."
              action={
                <div className="flex items-center gap-2">
                  <Label htmlFor="service-large-enabled" className="text-sm font-normal">
                    {form.largeBikeEnabled ? "Offered" : "Not offered"}
                  </Label>
                  <Switch
                    id="service-large-enabled"
                    checked={form.largeBikeEnabled}
                    onCheckedChange={(enabled) => {
                      setForm((current) =>
                        enabled
                          ? {
                              ...current,
                              largeBikeEnabled: true,
                              largeBikePrice: Number.NaN,
                              largeBikeDuration: current.defaultDuration,
                            }
                          : {
                              ...current,
                              largeBikeEnabled: false,
                              largeBikePrice: Number.NaN,
                              largeBikeDuration: Number.NaN,
                            },
                      );
                      clearError("largeBike");
                    }}
                  />
                </div>
              }
            >
              {form.largeBikeEnabled ? (
                <div className="space-y-2">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormField id="service-large-price" label="Price">
                      <PesoInput
                        id="service-large-price"
                        value={form.largeBikePrice}
                        invalid={Boolean(formErrors.largeBike)}
                        onChange={(largeBikePrice) => {
                          setForm({ ...form, largeBikePrice });
                          clearError("largeBike");
                        }}
                      />
                    </FormField>
                    <FormField id="service-large-duration" label="Duration (minutes)">
                      <Input
                        id="service-large-duration"
                        type="number"
                        inputMode="numeric"
                        min="15"
                        max="480"
                        step="15"
                        value={
                          Number.isFinite(form.largeBikeDuration) ? form.largeBikeDuration : ""
                        }
                        onChange={(event) => {
                          setForm({
                            ...form,
                            largeBikeDuration:
                              event.target.value === "" ? Number.NaN : Number(event.target.value),
                          });
                          clearError("largeBike");
                        }}
                        aria-invalid={Boolean(formErrors.largeBike)}
                      />
                    </FormField>
                  </div>
                  {formErrors.largeBike ? (
                    <FieldError message={formErrors.largeBike} />
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Must cost more than the Small Bike price and take at least as long as the
                      Small Bike duration (up to 480 minutes).
                    </p>
                  )}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed border-border/70 p-3 text-sm text-muted-foreground">
                  Large Bike bookings for this service are not available until you turn this on.
                </p>
              )}
            </FormSection>

            {editing && (
              <FormSection title="Status">
                <div className="flex items-start justify-between gap-4 rounded-lg border border-border/70 p-3">
                  <div>
                    <Label htmlFor="service-active">{form.isActive ? "Active" : "Inactive"}</Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Inactive services are hidden from the customer booking page.
                    </p>
                  </div>
                  <Switch
                    id="service-active"
                    checked={form.isActive}
                    onCheckedChange={(isActive) => {
                      setForm((current) => ({ ...current, isActive }));
                      setSaveError(null);
                    }}
                  />
                </div>
              </FormSection>
            )}

            {saveError && (
              <p
                role="alert"
                className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {saveError}
              </p>
            )}

            <DialogFooter className="gap-2 border-t border-border/70 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={closeEditor}
                disabled={save.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending && <Loader2 className="animate-spin" />}
                {editing ? "Save changes" : "Add service"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <AlertDialog open={saveConfirmationOpen} onOpenChange={setSaveConfirmationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {editing ? "Save changes to this service?" : "Add this service?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {editing
                ? "This will update the service details, the Small Bike duration, its status, and any Large Bike configuration."
                : "The service will be added with these details and prices. While it is active, customers can select it when booking."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={save.isPending}>Go back</AlertDialogCancel>
            <AlertDialogAction disabled={save.isPending} onClick={() => save.mutate()}>
              {editing ? "Save changes" : "Add service"}
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

function ServiceIdentity({ service }: { service: Service }) {
  return (
    <div className="min-w-0">
      <p className="font-medium break-words">{service.name}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        <span className="capitalize">{service.category}</span> · Added{" "}
        {new Date(service.created_at).toLocaleDateString("en-PH", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })}
      </p>
    </div>
  );
}

function StatusBadge({ active }: { active: boolean }) {
  return (
    <Badge variant="outline" className={`uppercase ${activeStatusTone(active)}`}>
      {active ? "Active" : "Inactive"}
    </Badge>
  );
}

function hasLargeBikePricing(service: Service) {
  return service.large_bike_price !== null && service.large_bike_duration_minutes !== null;
}

/** Small and Large Bike price and duration for one service. */
function ServicePricing({ service, layout }: { service: Service; layout: "inline" | "stacked" }) {
  const rows = [
    {
      label: "Small Bike",
      price: service.price,
      duration: service.duration_minutes,
    },
    {
      label: "Large Bike",
      price: hasLargeBikePricing(service) ? service.large_bike_price : null,
      duration: service.large_bike_duration_minutes,
    },
  ];
  return (
    <dl
      className={cn(
        "text-sm",
        layout === "inline"
          ? "grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:gap-x-8"
          : "space-y-1.5",
      )}
    >
      {rows.map((row) => (
        <div
          key={row.label}
          className={cn(
            "min-w-0",
            layout === "stacked" && "flex items-baseline justify-between gap-2",
          )}
        >
          <dt className="text-xs tracking-wide whitespace-nowrap text-muted-foreground uppercase">
            {row.label}
          </dt>
          <dd className={cn(layout === "inline" ? "mt-0.5" : "whitespace-nowrap")}>
            {row.price === null ? (
              <span className="text-xs text-muted-foreground">Not set</span>
            ) : (
              <>
                <span className="font-medium tabular-nums">{formatPHP(Number(row.price))}</span>
                <span className="text-xs text-muted-foreground"> · {row.duration} min</span>
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
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
    <div className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">
      <p
        ref={descriptionRef}
        className={cn(
          expanded ? "break-words" : "line-clamp-2 break-words",
          !description?.trim() && "italic",
        )}
      >
        {details}
      </p>
      {canExpand && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mt-0.5 h-auto p-0 text-xs md:h-auto"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} details for ${serviceName}`}
        >
          {expanded ? "See less" : "See more"}
        </Button>
      )}
    </div>
  );
}

function FormSection({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-base tracking-wide uppercase">{title}</h3>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function FormField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <FieldError message={error} />
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function PesoInput({
  id,
  value,
  invalid,
  onChange,
}: {
  id: string;
  value: number;
  invalid: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="relative">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground"
      >
        ₱
      </span>
      <Input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        value={Number.isFinite(value) ? value : ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? Number.NaN : Number(event.target.value))
        }
        aria-invalid={invalid}
        className="pl-7 tabular-nums"
      />
    </div>
  );
}

function ServiceViewDialog({
  service,
  onOpenChange,
  onEdit,
}: {
  service: Service | null;
  onOpenChange: (open: boolean) => void;
  onEdit: (service: Service) => void;
}) {
  return (
    <Dialog open={Boolean(service)} onOpenChange={onOpenChange}>
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-2xl">
        <DialogHeader>
          <p className="text-xs tracking-widest text-muted-foreground uppercase">Service details</p>
          <DialogTitle className="font-display text-2xl break-words uppercase">
            {service?.name}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="flex flex-wrap items-center justify-center gap-2 sm:justify-start">
              <span className="capitalize">{service?.category}</span>
              {service && <StatusBadge active={service.is_active} />}
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <section className="rounded-lg border border-border/70 bg-muted/20 p-4">
            <p className="text-xs tracking-wide text-muted-foreground uppercase">Details</p>
            <p className="mt-1 text-sm leading-relaxed break-words whitespace-pre-line">
              {service?.description || "No details provided."}
            </p>
          </section>
          {service && (
            <section className="grid gap-3 sm:grid-cols-2">
              <PricingCard
                title="Small Bike (125cc and below)"
                price={service.price}
                duration={service.duration_minutes}
              />
              {hasLargeBikePricing(service) ? (
                <PricingCard
                  title="Large Bike (126cc and above)"
                  price={service.large_bike_price}
                  duration={service.large_bike_duration_minutes}
                />
              ) : (
                <div className="rounded-lg border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                  <p className="text-xs tracking-wide uppercase">Large Bike (126cc and above)</p>
                  <p className="mt-3">Not offered for this service.</p>
                </div>
              )}
            </section>
          )}
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {service && (
            <Button onClick={() => onEdit(service)}>
              <Pencil /> Edit service
            </Button>
          )}
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
      <p className="mt-2 font-display text-2xl text-primary tabular-nums">
        {formatPHP(Number(price ?? 0))}
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Clock className="size-3.5" aria-hidden="true" /> {duration ?? 0} minutes
      </p>
    </div>
  );
}
