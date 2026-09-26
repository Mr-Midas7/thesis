import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Eye, Pencil } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

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
import { FieldError } from "@/components/ui/field-error";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { activeStatusTone, formatPHP } from "@/lib/shop";

export const Route = createFileRoute("/_authenticated/admin/prices")({
  component: PricesPage,
});

type PriceTableName = "services" | "products";

type PriceItem = {
  id: string;
  name: string;
  category: string;
  price: number;
  duration_minutes: number | null;
  is_active: boolean;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type StoredModelOverride = {
  id: string;
  service_id: string;
  brand: string;
  model: string;
  duration_minutes: number;
  price: number;
  created_at: string;
  updated_at: string;
};

type PriceConfiguration = {
  id: string;
  historyId: string | null;
  kind: "service-default" | "service-override" | "product";
  label: string;
  brand?: string;
  model?: string;
  durationMinutes: number | null;
  price: number;
  updatedAt: string;
};

type PriceHistoryRecord = {
  id: string;
  table_name: PriceTableName;
  item_id: string;
  item_name: string;
  configuration_id: string | null;
  configuration_label: string | null;
  old_price: number;
  new_price: number;
  reason: string | null;
  changed_by: string | null;
  changed_by_email: string | null;
  created_at: string;
};

type PriceDraft = { price: string; reason: string };
type PriceDraftErrors = { price?: string; reason?: string; form?: string };
type HistoryTarget = {
  table: PriceTableName;
  item: PriceItem;
  configuration?: PriceConfiguration;
};

function PricesPage() {
  const [showArchives, setShowArchives] = useState(false);

  return (
    <div>
      <PageHeader
        title="Prices Management"
        description={
          showArchives
            ? "Review archived service and parts price records and price histories."
            : "Update default prices and model overrides with a recorded reason for every change."
        }
        action={
          <Button
            variant={showArchives ? "default" : "outline"}
            className={
              showArchives
                ? "bg-emerald-600 font-display text-white uppercase hover:bg-emerald-700"
                : "border-border bg-muted font-display text-foreground uppercase shadow-sm hover:border-border hover:bg-muted/80 hover:text-foreground"
            }
            onClick={() => setShowArchives((current) => !current)}
          >
            {showArchives ? "Active" : "Archived"}
          </Button>
        }
      />

      <Tabs defaultValue="services">
        <TabsList className="mb-4 grid h-auto w-full grid-cols-2 overflow-x-auto p-1 md:overflow-visible sm:inline-flex sm:w-auto">
          <TabsTrigger value="services" className="w-full font-display uppercase sm:w-auto">
            Services
          </TabsTrigger>
          <TabsTrigger value="products" className="w-full font-display uppercase sm:w-auto">
            Parts & Accessories
          </TabsTrigger>
        </TabsList>
        <TabsContent value="services">
          <PriceCatalog table="services" archived={showArchives} />
        </TabsContent>
        <TabsContent value="products">
          <PriceCatalog table="products" archived={showArchives} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function PriceCatalog({ table, archived }: { table: PriceTableName; archived: boolean }) {
  const queryClient = useQueryClient();
  const [selectedItem, setSelectedItem] = useState<PriceItem | null>(null);
  const [historyTarget, setHistoryTarget] = useState<HistoryTarget | null>(null);
  const [archiveViewTarget, setArchiveViewTarget] = useState<PriceItem | null>(null);
  const [drafts, setDrafts] = useState<Record<string, PriceDraft>>({});
  const [priceErrors, setPriceErrors] = useState<Record<string, PriceDraftErrors>>({});
  const [saveTarget, setSaveTarget] = useState<PriceConfiguration | null>(null);

  const items = useQuery({
    queryKey: ["prices", table, archived],
    queryFn: async (): Promise<PriceItem[]> => {
      if (table === "services") {
        const { data, error } = await supabase
          .from("services")
          .select(
            "id,name,category,price,duration_minutes,is_active,is_archived,created_at,updated_at,archived_at",
          )
          .eq("is_archived", archived)
          .order("name");
        if (error) throw error;
        return data ?? [];
      }

      const { data, error } = await supabase
        .from("products")
        .select("id,name,category,price,is_active,is_archived,created_at,updated_at,archived_at")
        .in("category", ["part", "accessory"])
        .eq("is_archived", archived)
        .order("name");
      if (error) throw error;
      return (data ?? []).map((product) => ({ ...product, duration_minutes: null }));
    },
  });

  const serviceModelOverrides = useQuery({
    queryKey: ["service-model-overrides"],
    queryFn: async (): Promise<StoredModelOverride[]> => {
      const { data, error } = await supabase
        .from("service_model_overrides")
        .select("id,service_id,brand,model,duration_minutes,price,created_at,updated_at")
        .order("created_at");
      if (error) throw error;
      return data ?? [];
    },
    enabled: table === "services",
  });

  const priceHistory = useQuery({
    queryKey: ["price-history-index", table],
    queryFn: async (): Promise<PriceHistoryRecord[]> => {
      const { data, error } = await supabase
        .from("price_history")
        .select(
          "id,table_name,item_id,item_name,configuration_id,configuration_label,old_price,new_price,reason,changed_by,changed_by_email,created_at",
        )
        .eq("table_name", table)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PriceHistoryRecord[];
    },
  });

  useEffect(() => {
    setSelectedItem(null);
    setDrafts({});
    setPriceErrors({});
    setSaveTarget(null);
  }, [archived, table]);

  function configurationsFor(item: PriceItem): PriceConfiguration[] {
    if (table === "products") {
      return [
        {
          id: item.id,
          historyId: item.id,
          kind: "product",
          label: productConfigurationLabel(item),
          durationMinutes: null,
          price: Number(item.price),
          updatedAt: item.updated_at,
        },
      ];
    }

    const overrides = (serviceModelOverrides.data ?? []).filter(
      (override) => override.service_id === item.id,
    );
    return [
      {
        id: `default-${item.id}`,
        historyId: null,
        kind: "service-default",
        label: "Default Price",
        durationMinutes: item.duration_minutes,
        price: Number(item.price),
        updatedAt: item.updated_at,
      },
      ...overrides.map((override) => ({
        id: override.id,
        historyId: override.id,
        kind: "service-override" as const,
        label: `${override.brand} · ${modelLabel(override.brand, override.model)}`,
        brand: override.brand,
        model: override.model,
        durationMinutes: override.duration_minutes,
        price: Number(override.price),
        updatedAt: override.updated_at,
      })),
    ];
  }

  function configurationCount(item: PriceItem) {
    return table === "services"
      ? (serviceModelOverrides.data ?? []).filter((override) => override.service_id === item.id)
          .length
      : 1;
  }

  function historyFor(item: PriceItem, configuration?: PriceConfiguration) {
    return (priceHistory.data ?? []).filter((record) => {
      if (record.item_id !== item.id) return false;
      if (!configuration) return true;
      return configuration.historyId === null
        ? record.configuration_id === null
        : record.configuration_id === configuration.historyId;
    });
  }

  function lastPriceDate(item: PriceItem, configuration?: PriceConfiguration) {
    return historyFor(item, configuration)[0]?.created_at ?? configuration?.updatedAt ?? null;
  }

  const savePrice = useMutation({
    mutationFn: async ({
      item,
      configuration,
      newPrice,
      reason,
    }: {
      item: PriceItem;
      configuration: PriceConfiguration;
      newPrice: number;
      reason: string;
    }) => {
      if (table === "services") {
        if (configuration.kind === "service-override") {
          const { error } = await supabase
            .from("service_model_overrides")
            .update({ price: newPrice })
            .eq("id", configuration.id);
          if (error) throw error;
        } else {
          const { error } = await supabase
            .from("services")
            .update({ price: newPrice })
            .eq("id", item.id);
          if (error) throw error;
        }
      } else {
        const { error } = await supabase
          .from("products")
          .update({ price: newPrice })
          .eq("id", item.id);
        if (error) throw error;
      }

      const { data: userData } = await supabase.auth.getUser();
      const { error: historyError } = await supabase.from("price_history").insert({
        table_name: table,
        item_id: item.id,
        item_name: item.name,
        configuration_id: configuration.historyId,
        configuration_label: configuration.label,
        old_price: configuration.price,
        new_price: newPrice,
        reason,
        changed_by: userData.user?.id ?? null,
        changed_by_email: userData.user?.email ?? null,
      });
      if (historyError) throw historyError;
    },
    onSuccess: (_, variables) => {
      setSaveTarget(null);
      setDrafts((current) => {
        const next = { ...current };
        delete next[variables.configuration.id];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ["prices"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["price-history-index", table] });
      queryClient.invalidateQueries({ queryKey: ["price-history-dialog"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["service-model-overrides"] });
      queryClient.invalidateQueries({ queryKey: ["services"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["products"], exact: false });
    },
    onError: (error: Error, variables) => {
      setSaveTarget(null);
      setPriceErrors((current) => ({
        ...current,
        [variables.configuration.id]: { form: "Could not save this price. Please try again." },
      }));
    },
  });

  function draftFor(configuration: PriceConfiguration): PriceDraft {
    return drafts[configuration.id] ?? { price: String(configuration.price), reason: "" };
  }

  function updateDraft(configuration: PriceConfiguration, changes: Partial<PriceDraft>) {
    setDrafts((current) => ({
      ...current,
      [configuration.id]: { ...draftFor(configuration), ...changes },
    }));
    setPriceErrors((current) => ({
      ...current,
      [configuration.id]: {
        ...current[configuration.id],
        ...Object.fromEntries(Object.keys(changes).map((key) => [key, undefined])),
      },
    }));
  }

  function requestSave(configuration: PriceConfiguration) {
    const draft = draftFor(configuration);
    const nextPrice = Number(draft.price);
    const nextErrors: PriceDraftErrors = {};
    if (!Number.isFinite(nextPrice) || nextPrice < 0) {
      nextErrors.price = "Enter a valid price of PHP 0 or more.";
    } else if (nextPrice === configuration.price) {
      nextErrors.price = "Enter a changed price to save.";
    }
    if (!draft.reason.trim()) {
      nextErrors.reason = "Enter a reason for the price change.";
    }
    if (Object.keys(nextErrors).length > 0) {
      setPriceErrors((current) => ({ ...current, [configuration.id]: nextErrors }));
      return;
    }
    setSaveTarget(configuration);
  }

  const configurations = selectedItem ? configurationsFor(selectedItem) : [];

  if (selectedItem && !archived) {
    return (
      <>
        {table === "services" ? (
          <ServicePriceTables
            item={selectedItem}
            configurations={configurations}
            draftFor={draftFor}
            errors={priceErrors}
            onDraftChange={updateDraft}
            onSave={requestSave}
            onViewHistory={(configuration) =>
              setHistoryTarget({ table, item: selectedItem, configuration })
            }
            onBack={() => setSelectedItem(null)}
            latestDateFor={(configuration) => lastPriceDate(selectedItem, configuration)}
            saving={savePrice.isPending}
          />
        ) : (
          <ConfigurationPriceTable
            item={selectedItem}
            configurations={configurations}
            draftFor={draftFor}
            errors={priceErrors}
            onDraftChange={updateDraft}
            onSave={requestSave}
            onViewHistory={(configuration) =>
              setHistoryTarget({ table, item: selectedItem, configuration })
            }
            onBack={() => setSelectedItem(null)}
            latestDateFor={(configuration) => lastPriceDate(selectedItem, configuration)}
            saving={savePrice.isPending}
          />
        )}
        <PriceHistoryDialog
          target={historyTarget}
          onOpenChange={(open) => !open && setHistoryTarget(null)}
        />
        <PriceSaveConfirmation
          configuration={saveTarget}
          draft={saveTarget ? draftFor(saveTarget) : null}
          pending={savePrice.isPending}
          onClose={() => setSaveTarget(null)}
          onConfirm={() => {
            if (!saveTarget) return;
            const draft = draftFor(saveTarget);
            savePrice.mutate({
              item: selectedItem,
              configuration: saveTarget,
              newPrice: Number(draft.price),
              reason: draft.reason.trim(),
            });
          }}
        />
      </>
    );
  }

  return (
    <>
      <Card className="mt-4 border-border/70 bg-card/60">
        <CardContent className={archived ? "overflow-hidden p-0" : "overflow-x-auto p-0"}>
          {archived ? (
            <ArchivedPriceTable
              table={table}
              rows={items.data ?? []}
              configurationsFor={configurationsFor}
              onView={setArchiveViewTarget}
              onViewHistory={(item) => setHistoryTarget({ table, item })}
              loading={items.isLoading}
            />
          ) : (
            <ActivePriceTable
              table={table}
              rows={items.data ?? []}
              configurationCount={configurationCount}
              lastPriceDate={lastPriceDate}
              onEdit={setSelectedItem}
              loading={items.isLoading}
            />
          )}
        </CardContent>
      </Card>

      <ArchivedConfigurationDialog
        item={archiveViewTarget}
        configurations={archiveViewTarget ? configurationsFor(archiveViewTarget) : []}
        onOpenChange={(open) => !open && setArchiveViewTarget(null)}
      />
      <PriceHistoryDialog
        target={historyTarget}
        onOpenChange={(open) => !open && setHistoryTarget(null)}
      />
    </>
  );
}

function ActivePriceTable({
  table,
  rows,
  configurationCount,
  lastPriceDate,
  onEdit,
  loading,
}: {
  table: PriceTableName;
  rows: PriceItem[];
  configurationCount: (item: PriceItem) => number;
  lastPriceDate: (item: PriceItem) => string | null;
  onEdit: (item: PriceItem) => void;
  loading: boolean;
}) {
  const label = table === "services" ? "services" : "parts or accessories";
  return (
    <Table className="admin-data-table admin-balanced-table w-full min-w-[760px]">
      <colgroup>
        <col style={{ width: "16%" }} />
        <col style={{ width: "24%" }} />
        <col style={{ width: "15%" }} />
        <col style={{ width: "13%" }} />
        <col style={{ width: "14%" }} />
        <col style={{ width: "10%" }} />
        <col style={{ width: "8%" }} />
      </colgroup>
      <TableHeader>
        <TableRow>
          <TableHead className="text-left">Price Date</TableHead>
          <TableHead className="text-left">
            {table === "services" ? "Service" : "Part / Accessory"}
          </TableHead>
          <TableHead className="text-center">Category</TableHead>
          <TableHead className="text-center">
            {table === "services" ? "Model Overrides" : "Configurations"}
          </TableHead>
          <TableHead className="text-right">Current Price</TableHead>
          <TableHead className="text-center">Status</TableHead>
          <TableHead className="text-center">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((item) => (
          <TableRow key={item.id}>
            <TableCell
              data-label="Price Date"
              className="whitespace-nowrap text-left text-xs text-muted-foreground"
            >
              {formatDateTime(lastPriceDate(item))}
            </TableCell>
            <TableCell
              data-label={table === "services" ? "Service" : "Part / Accessory"}
              className="text-left text-sm"
            >
              {item.name}
            </TableCell>
            <TableCell data-label="Category" className="text-center text-sm capitalize">
              {item.category}
            </TableCell>
            <TableCell
              data-label={table === "services" ? "Model Overrides" : "Configurations"}
              className="text-center text-sm"
            >
              {configurationCount(item)}
            </TableCell>
            <TableCell data-label="Current Price" className="text-right text-sm text-primary">
              {formatPHP(item.price)}
            </TableCell>
            <TableCell data-label="Status" className="text-center">
              <Badge variant="outline" className={`uppercase ${activeStatusTone(item.is_active)}`}>
                {item.is_active ? "Active" : "Deactivated"}
              </Badge>
            </TableCell>
            <TableCell data-label="Actions" className="text-center">
              <Button size="sm" variant="ghost" onClick={() => onEdit(item)}>
                <Pencil className="h-4 w-4" /> Edit
              </Button>
            </TableCell>
          </TableRow>
        ))}
        {rows.length === 0 && (
          <EmptyRow
            colSpan={7}
            message={loading ? "Loading price records…" : `No active ${label} found.`}
          />
        )}
      </TableBody>
    </Table>
  );
}

function ConfigurationPriceTable({
  item,
  configurations,
  draftFor,
  errors,
  onDraftChange,
  onSave,
  onViewHistory,
  onBack,
  latestDateFor,
  saving,
}: {
  item: PriceItem;
  configurations: PriceConfiguration[];
  draftFor: (configuration: PriceConfiguration) => PriceDraft;
  errors: Record<string, PriceDraftErrors>;
  onDraftChange: (configuration: PriceConfiguration, changes: Partial<PriceDraft>) => void;
  onSave: (configuration: PriceConfiguration) => void;
  onViewHistory: (configuration: PriceConfiguration) => void;
  onBack: () => void;
  latestDateFor: (configuration: PriceConfiguration) => string | null;
  saving: boolean;
}) {
  return (
    <Card className="mt-4 border-border/70 bg-card/60">
      <CardContent className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-display text-lg uppercase">{item.name}</p>
            <p className="text-sm text-muted-foreground">
              Update a configuration price and record why it changed.
            </p>
          </div>
          <Button variant="outline" onClick={onBack} disabled={saving}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        </div>
        <div className="overflow-x-auto rounded-md border border-border/70">
          <Table className="admin-data-table admin-balanced-table min-w-[1140px]">
            <colgroup>
              <col style={{ width: "14%" }} />
              <col style={{ width: "24%" }} />
              <col style={{ width: "12%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "20%" }} />
              <col style={{ width: "16%" }} />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="text-left">Date &amp; Time</TableHead>
                <TableHead className="text-left">Price Type</TableHead>
                <TableHead className="text-left">Old Price</TableHead>
                <TableHead className="text-left">New Price</TableHead>
                <TableHead className="text-left">Reason for Price Change</TableHead>
                <TableHead className="text-left">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {configurations.map((configuration) => {
                const draft = draftFor(configuration);
                return (
                  <TableRow key={configuration.id}>
                    <TableCell
                      data-label="Date & Time"
                      className="whitespace-nowrap text-xs text-muted-foreground"
                    >
                      {formatDateTime(latestDateFor(configuration))}
                    </TableCell>
                    <TableCell data-label="Configuration" className="text-sm">
                      {configuration.label}
                    </TableCell>
                    <TableCell data-label="Old Price" className="text-sm text-muted-foreground">
                      {formatPHP(configuration.price)}
                    </TableCell>
                    <TableCell data-label="New Price">
                      <Input
                        className="min-w-28"
                        type="number"
                        min="0"
                        step="0.01"
                        inputMode="decimal"
                        value={draft.price}
                        onChange={(event) =>
                          onDraftChange(configuration, { price: event.target.value })
                        }
                        aria-label={`New price for ${configuration.label}`}
                        aria-invalid={!!errors[configuration.id]}
                      />
                    </TableCell>
                    <TableCell data-label="Reason for Price Change">
                      <Input
                        className="min-w-48"
                        placeholder="e.g. supplier cost increase"
                        value={draft.reason}
                        onChange={(event) =>
                          onDraftChange(configuration, { reason: event.target.value })
                        }
                        aria-label={`Reason for ${configuration.label} price change`}
                        aria-invalid={!!errors[configuration.id]}
                      />
                      <FieldError
                        message={errors[configuration.id]?.reason ?? errors[configuration.id]?.form}
                      />
                    </TableCell>
                    <TableCell data-label="Actions" className="align-middle">
                      <div className="flex items-center gap-1 whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={saving}
                          onClick={() => onSave(configuration)}
                        >
                          Save
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onViewHistory(configuration)}
                        >
                          View History
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function ServicePriceTables({
  item,
  configurations,
  draftFor,
  errors,
  onDraftChange,
  onSave,
  onViewHistory,
  onBack,
  latestDateFor,
  saving,
}: {
  item: PriceItem;
  configurations: PriceConfiguration[];
  draftFor: (configuration: PriceConfiguration) => PriceDraft;
  errors: Record<string, PriceDraftErrors>;
  onDraftChange: (configuration: PriceConfiguration, changes: Partial<PriceDraft>) => void;
  onSave: (configuration: PriceConfiguration) => void;
  onViewHistory: (configuration: PriceConfiguration) => void;
  onBack: () => void;
  latestDateFor: (configuration: PriceConfiguration) => string | null;
  saving: boolean;
}) {
  const defaultPrice = configurations.find(
    (configuration) => configuration.kind === "service-default",
  );
  const overrides = configurations.filter(
    (configuration) => configuration.kind === "service-override",
  );

  const actionButtons = (configuration: PriceConfiguration) => (
    <div className="flex flex-wrap items-center justify-end gap-1 sm:flex-nowrap sm:justify-center">
      <Button size="sm" variant="outline" disabled={saving} onClick={() => onSave(configuration)}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onViewHistory(configuration)}>
        View History
      </Button>
    </div>
  );

  return (
    <Card className="mt-4 border-border/70 bg-card/60">
      <CardContent className="space-y-6 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-display text-lg uppercase">{item.name}</p>
            <p className="text-sm text-muted-foreground">
              Update the default price or a model-specific override independently.
            </p>
          </div>
          <Button variant="outline" onClick={onBack} disabled={saving}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        </div>

        {defaultPrice && (
          <section className="space-y-3">
            <h2 className="font-display text-base uppercase">Default Price</h2>
            <div className="overflow-x-auto rounded-md border border-border/70">
              <Table className="admin-data-table admin-balanced-table w-full min-w-[760px]">
                <colgroup>
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "31%" }} />
                  <col style={{ width: "18%" }} />
                </colgroup>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-left">Date &amp; Time</TableHead>
                    <TableHead className="text-right">Old Price</TableHead>
                    <TableHead className="text-right">New Price</TableHead>
                    <TableHead className="text-left">Reason for Change</TableHead>
                    <TableHead className="text-center">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <PriceEditRow
                    configuration={defaultPrice}
                    draft={draftFor(defaultPrice)}
                    error={errors[defaultPrice.id]}
                    date={latestDateFor(defaultPrice)}
                    onDraftChange={onDraftChange}
                    actions={actionButtons(defaultPrice)}
                  />
                </TableBody>
              </Table>
            </div>
          </section>
        )}

        <section className="space-y-3 border-t border-border/70 pt-5">
          <h2 className="font-display text-base uppercase">Model Overrides</h2>
          <div className="overflow-x-auto rounded-md border border-border/70">
            <Table className="admin-data-table admin-balanced-table w-full min-w-[980px]">
              <colgroup>
                <col style={{ width: "15%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "12%" }} />
                <col style={{ width: "14%" }} />
                <col style={{ width: "19%" }} />
                <col style={{ width: "12%" }} />
              </colgroup>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-left">Date &amp; Time</TableHead>
                  <TableHead className="text-left">Brand</TableHead>
                  <TableHead className="text-left">Model</TableHead>
                  <TableHead className="text-right">Old Price</TableHead>
                  <TableHead className="text-right">New Price</TableHead>
                  <TableHead className="text-left">Reason for Change</TableHead>
                  <TableHead className="text-center">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {overrides.map((override) => (
                  <PriceEditRow
                    key={override.id}
                    configuration={override}
                    draft={draftFor(override)}
                    error={errors[override.id]}
                    date={latestDateFor(override)}
                    brand={override.brand}
                    model={override.model ? modelLabel(override.brand ?? "", override.model) : "—"}
                    onDraftChange={onDraftChange}
                    actions={actionButtons(override)}
                  />
                ))}
                {overrides.length === 0 && (
                  <EmptyRow colSpan={7} message="No model overrides configured for this service." />
                )}
              </TableBody>
            </Table>
          </div>
        </section>
      </CardContent>
    </Card>
  );
}

function PriceEditRow({
  configuration,
  draft,
  error,
  date,
  brand,
  model,
  onDraftChange,
  actions,
}: {
  configuration: PriceConfiguration;
  draft: PriceDraft;
  error: PriceDraftErrors | undefined;
  date: string | null;
  brand?: string | undefined;
  model?: string | undefined;
  onDraftChange: (configuration: PriceConfiguration, changes: Partial<PriceDraft>) => void;
  actions: ReactNode;
}) {
  return (
    <TableRow>
      <TableCell
        data-label="Date & Time"
        className="whitespace-nowrap text-xs text-muted-foreground"
      >
        {formatDateTime(date)}
      </TableCell>
      {brand !== undefined && <TableCell data-label="Brand">{brand}</TableCell>}
      {model !== undefined && <TableCell data-label="Model">{model}</TableCell>}
      <TableCell data-label="Old Price" className="text-right text-muted-foreground">
        {formatPHP(configuration.price)}
      </TableCell>
      <TableCell data-label="New Price">
        <Input
          className="min-w-28"
          type="number"
          min="0"
          step="0.01"
          value={draft.price}
          onChange={(event) => onDraftChange(configuration, { price: event.target.value })}
          aria-label={`New price for ${configuration.label}`}
          aria-invalid={Boolean(error?.price)}
          tabIndex={0}
        />
        <FieldError message={error?.price} />
      </TableCell>
      <TableCell data-label="Reason for Change">
        <Input
          className="min-w-48"
          placeholder="Reason for change"
          value={draft.reason}
          onChange={(event) => onDraftChange(configuration, { reason: event.target.value })}
          aria-label={`Reason for ${configuration.label} price change`}
          aria-invalid={Boolean(error?.reason || error?.form)}
        />
        <FieldError message={error?.reason || error?.form} />
      </TableCell>
      <TableCell data-label="Action" className="align-middle text-center">
        {actions}
      </TableCell>
    </TableRow>
  );
}

function ArchivedPriceTable({
  table,
  rows,
  configurationsFor,
  onView,
  onViewHistory,
  loading,
}: {
  table: PriceTableName;
  rows: PriceItem[];
  configurationsFor: (item: PriceItem) => PriceConfiguration[];
  onView: (item: PriceItem) => void;
  onViewHistory: (item: PriceItem) => void;
  loading: boolean;
}) {
  const label = table === "services" ? "services" : "parts or accessories";
  return (
    <Table className="admin-data-table admin-balanced-table w-full table-fixed">
      <colgroup>
        <col style={{ width: "15%" }} />
        <col style={{ width: "24%" }} />
        <col style={{ width: "14%" }} />
        <col style={{ width: "15%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "20%" }} />
      </colgroup>
      <TableHeader>
        <TableRow>
          <TableHead className="align-middle text-left">Archived Date</TableHead>
          <TableHead className="align-middle text-left">
            {table === "services" ? "Service" : "Part / Accessory"}
          </TableHead>
          <TableHead className="align-middle text-left">Category</TableHead>
          <TableHead className="align-middle text-center">
            {table === "services" ? "Model Overrides" : "Configurations"}
          </TableHead>
          <TableHead className="align-middle text-center">Status</TableHead>
          <TableHead className="align-middle text-center">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((item) => (
          <TableRow key={item.id}>
            <TableCell
              data-label="Archived Date"
              className="align-middle text-xs leading-snug text-muted-foreground"
            >
              {formatDateTime(item.archived_at ?? item.updated_at)}
            </TableCell>
            <TableCell
              data-label={table === "services" ? "Service" : "Part / Accessory"}
              className="align-middle break-words text-sm"
            >
              {item.name}
            </TableCell>
            <TableCell
              data-label="Category"
              className="align-middle break-words text-sm capitalize"
            >
              {item.category}
            </TableCell>
            <TableCell
              data-label={table === "services" ? "Model Overrides" : "Configurations"}
              className="align-middle text-center text-sm"
            >
              {table === "services"
                ? configurationsFor(item).filter((row) => row.kind === "service-override").length
                : 1}
            </TableCell>
            <TableCell data-label="Status" className="align-middle text-center">
              <Badge variant="outline" className="uppercase text-muted-foreground">
                Archived
              </Badge>
            </TableCell>
            <TableCell data-label="Actions" className="align-middle text-center">
              <div className="flex flex-wrap items-center justify-center gap-1">
                <Button size="sm" variant="ghost" className="px-2" onClick={() => onView(item)}>
                  <Eye className="h-4 w-4" /> View
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="px-2"
                  onClick={() => onViewHistory(item)}
                >
                  View History
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
        {rows.length === 0 && (
          <EmptyRow
            colSpan={6}
            message={loading ? "Loading archived records…" : `No archived ${label} found.`}
          />
        )}
      </TableBody>
    </Table>
  );
}

function ArchivedConfigurationDialog({
  item,
  configurations,
  onOpenChange,
}: {
  item: PriceItem | null;
  configurations: PriceConfiguration[];
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={!!item} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="font-display uppercase">
            {item ? `${item.name} pricing details` : "Archived pricing details"}
          </DialogTitle>
          <DialogDescription>
            Latest default and model-override pricing at the time of archiving.
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-x-auto">
          <Table className="admin-data-table admin-balanced-table min-w-[660px]">
            <colgroup>
              <col style={{ width: "52%" }} />
              <col style={{ width: "24%" }} />
              <col style={{ width: "24%" }} />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="text-left">Price Type</TableHead>
                <TableHead className="text-left">Duration</TableHead>
                <TableHead className="text-left">Latest Price</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {configurations.map((configuration) => (
                <TableRow key={configuration.id}>
                  <TableCell data-label="Price Type" className="text-sm">
                    {configuration.label}
                  </TableCell>
                  <TableCell data-label="Duration" className="text-sm">
                    {configuration.durationMinutes ? `${configuration.durationMinutes} min` : "—"}
                  </TableCell>
                  <TableCell data-label="Latest Price" className="text-sm text-primary">
                    {formatPHP(configuration.price)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <ArrowLeft className="h-4 w-4" /> Back / Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PriceHistoryDialog({
  target,
  onOpenChange,
}: {
  target: HistoryTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const history = useQuery({
    queryKey: [
      "price-history-dialog",
      target?.item.id,
      target?.configuration?.historyId ?? "all-or-base",
    ],
    queryFn: async (): Promise<PriceHistoryRecord[]> => {
      if (!target) return [];
      let query = supabase
        .from("price_history")
        .select(
          "id,table_name,item_id,item_name,configuration_id,configuration_label,old_price,new_price,reason,changed_by,changed_by_email,created_at",
        )
        .eq("table_name", target.table)
        .eq("item_id", target.item.id)
        .order("created_at", { ascending: false });

      if (target.configuration) {
        query =
          target.configuration.historyId === null
            ? query.is("configuration_id", null)
            : query.eq("configuration_id", target.configuration.historyId);
      }
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as PriceHistoryRecord[];
    },
    enabled: !!target,
  });

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-6xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-display uppercase">
            {target ? `${target.item.name} price history` : "Price history"}
          </DialogTitle>
          <DialogDescription>
            {target?.configuration
              ? `Price changes for ${target.configuration.label}.`
              : "Price changes across the selected item."}
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-x-auto">
          <Table className="admin-data-table admin-balanced-table min-w-[900px]">
            <colgroup>
              <col style={{ width: "20%" }} />
              <col style={{ width: "30%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "22%" }} />
            </colgroup>
            <TableHeader>
              <TableRow>
                <TableHead className="text-left">Date &amp; Time</TableHead>
                <TableHead className="text-left">Configuration</TableHead>
                <TableHead className="text-left">Old Price</TableHead>
                <TableHead className="text-left">New Price</TableHead>
                <TableHead className="text-left">Reason for Price Change</TableHead>
                <TableHead className="text-left">Administrator</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.data?.map((record) => (
                <TableRow key={record.id}>
                  <TableCell
                    data-label="Date & Time"
                    className="whitespace-nowrap text-xs text-muted-foreground"
                  >
                    {formatDateTime(record.created_at)}
                  </TableCell>
                  <TableCell data-label="Price Type" className="text-sm">
                    {record.configuration_label ?? defaultHistoryConfiguration(record.table_name)}
                  </TableCell>
                  <TableCell data-label="Old Price" className="text-sm text-muted-foreground">
                    {formatPHP(record.old_price)}
                  </TableCell>
                  <TableCell data-label="New Price" className="text-sm text-primary">
                    {formatPHP(record.new_price)}
                  </TableCell>
                  <TableCell
                    data-label="Reason for Price Change"
                    className="text-sm text-muted-foreground"
                  >
                    {record.reason ?? "—"}
                  </TableCell>
                  <TableCell data-label="Administrator" className="text-sm text-muted-foreground">
                    {record.changed_by_email ??
                      (record.changed_by ? `Admin · ${record.changed_by.slice(0, 8)}` : "Unknown")}
                  </TableCell>
                </TableRow>
              ))}
              {history.data?.length === 0 && (
                <EmptyRow colSpan={6} message="No price changes recorded." />
              )}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <ArrowLeft className="h-4 w-4" /> Back / Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PriceSaveConfirmation({
  configuration,
  draft,
  pending,
  onClose,
  onConfirm,
}: {
  configuration: PriceConfiguration | null;
  draft: PriceDraft | null;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={!!configuration} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Save price change?</AlertDialogTitle>
          <AlertDialogDescription>
            {configuration && draft
              ? `${configuration.label} will change from ${formatPHP(configuration.price)} to ${formatPHP(Number(draft.price))}.`
              : "Confirm this price update."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={onConfirm}>
            Save Price Change
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <TableRow data-empty-row>
      <TableCell colSpan={colSpan} className="py-8 text-center text-sm text-muted-foreground">
        {message}
      </TableCell>
    </TableRow>
  );
}

function productConfigurationLabel(item: PriceItem) {
  return item.category === "accessory" ? "Accessory" : "Part";
}

function modelLabel(brand: string, model: string) {
  return model.replace(new RegExp(`^${brand} `), "");
}

function defaultHistoryConfiguration(table: PriceTableName) {
  return table === "services" ? "Default price" : "Default item";
}

function formatDateTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
