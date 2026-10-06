import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft, Eye, Pencil } from "lucide-react";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/admin/page-header";
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
import { FieldError } from "@/components/ui/field-error";
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

export const Route = createFileRoute("/_authenticated/admin/prices")({ component: PricesPage });

type PriceTable = "services" | "products";
type PriceItem = {
  id: string;
  name: string;
  category: string;
  price: number;
  duration_minutes: number | null;
  large_bike_price: number | null;
  large_bike_duration_minutes: number | null;
  is_active: boolean;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};
type PriceConfiguration = {
  id: string;
  historyId: string | null;
  kind: "small_bike" | "large_bike" | "product";
  label: string;
  price: number;
  durationMinutes: number | null;
};
type PriceHistory = {
  id: string;
  item_id: string;
  configuration_id: string | null;
  configuration_label: string | null;
  old_price: number;
  new_price: number;
  reason: string | null;
  changed_by_email: string | null;
  created_at: string;
};

function PricesPage() {
  const [showArchives, setShowArchives] = useState(false);
  return (
    <div>
      <PageHeader
        title="Prices Management"
        description={
          showArchives
            ? "Review archived service and parts prices."
            : "Update Small Bike, Large Bike, and parts prices with a recorded reason."
        }
        action={
          <Button
            variant={showArchives ? "default" : "outline"}
            onClick={() => setShowArchives((current) => !current)}
          >
            {showArchives ? "Active" : "Archived"}
          </Button>
        }
      />
      <Tabs defaultValue="services">
        <TabsList className="mb-4 grid h-auto w-full grid-cols-2 sm:inline-flex sm:w-auto">
          <TabsTrigger value="services">Services</TabsTrigger>
          <TabsTrigger value="products">Parts & Accessories</TabsTrigger>
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

function PriceCatalog({ table, archived }: { table: PriceTable; archived: boolean }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<PriceItem | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { price: string; reason: string }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const items = useQuery({
    queryKey: ["prices", table, archived],
    queryFn: async (): Promise<PriceItem[]> => {
      if (table === "services") {
        const { data, error } = await supabase
          .from("services")
          .select(
            "id,name,category,price,duration_minutes,large_bike_price,large_bike_duration_minutes,is_active,is_archived,created_at,updated_at,archived_at",
          )
          .eq("is_archived", archived)
          .order("name");
        if (error) throw error;
        return (data ?? []).map((item) => ({
          ...item,
          price: Number(item.price),
          large_bike_price: item.large_bike_price === null ? null : Number(item.large_bike_price),
        }));
      }
      const { data, error } = await supabase
        .from("products")
        .select("id,name,category,price,is_active,is_archived,created_at,updated_at,archived_at")
        .in("category", ["part", "accessory"])
        .eq("is_archived", archived)
        .order("name");
      if (error) throw error;
      return (data ?? []).map((item) => ({
        ...item,
        price: Number(item.price),
        duration_minutes: null,
        large_bike_price: null,
        large_bike_duration_minutes: null,
      }));
    },
  });

  const history = useQuery({
    queryKey: ["price-history-index", table],
    queryFn: async (): Promise<PriceHistory[]> => {
      const { data, error } = await supabase
        .from("price_history")
        .select(
          "id,item_id,configuration_id,configuration_label,old_price,new_price,reason,changed_by_email,created_at",
        )
        .eq("table_name", table)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PriceHistory[];
    },
  });

  useEffect(() => {
    setSelected(null);
    setDrafts({});
    setErrors({});
  }, [archived, table]);

  function configurationsFor(item: PriceItem): PriceConfiguration[] {
    if (table === "products")
      return [
        {
          id: item.id,
          historyId: item.id,
          kind: "product",
          label: "Price",
          price: item.price,
          durationMinutes: null,
        },
      ];
    const configurations: PriceConfiguration[] = [
      {
        id: `small-${item.id}`,
        historyId: null,
        kind: "small_bike",
        label: "Small Bike (125cc and below)",
        price: item.price,
        durationMinutes: item.duration_minutes,
      },
    ];
    if (item.large_bike_price !== null && item.large_bike_duration_minutes !== null)
      configurations.push({
        id: `large-${item.id}`,
        historyId: item.id,
        kind: "large_bike",
        label: "Large Bike (126cc and above)",
        price: item.large_bike_price,
        durationMinutes: item.large_bike_duration_minutes,
      });
    return configurations;
  }

  const save = useMutation({
    mutationFn: async ({
      item,
      configuration,
      price,
      reason,
    }: {
      item: PriceItem;
      configuration: PriceConfiguration;
      price: number;
      reason: string;
    }) => {
      if (table === "services") {
        const update =
          configuration.kind === "large_bike" ? { large_bike_price: price } : { price };
        const { error } = await supabase.from("services").update(update).eq("id", item.id);
        if (error) throw error;
      } else {
        const { error } = await supabase.from("products").update({ price }).eq("id", item.id);
        if (error) throw error;
      }
      const { data: user } = await supabase.auth.getUser();
      const { error } = await supabase.from("price_history").insert({
        table_name: table,
        item_id: item.id,
        item_name: item.name,
        configuration_id: configuration.historyId,
        configuration_label: configuration.label,
        old_price: configuration.price,
        new_price: price,
        reason,
        changed_by: user.user?.id ?? null,
        changed_by_email: user.user?.email ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prices"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["price-history-index", table] });
      queryClient.invalidateQueries({ queryKey: ["services"], exact: false });
      queryClient.invalidateQueries({ queryKey: ["products"], exact: false });
    },
    onError: (_error, variables) => {
      setErrors((current) => ({
        ...current,
        [variables.configuration.id]:
          "Could not save this price. Please review the value and try again.",
      }));
    },
  });

  function draftFor(configuration: PriceConfiguration) {
    return drafts[configuration.id] ?? { price: String(configuration.price), reason: "" };
  }
  function setDraft(
    configuration: PriceConfiguration,
    changes: Partial<{ price: string; reason: string }>,
  ) {
    setDrafts((current) => ({
      ...current,
      [configuration.id]: { ...draftFor(configuration), ...changes },
    }));
    setErrors((current) => ({ ...current, [configuration.id]: "" }));
  }
  function requestSave(item: PriceItem, configuration: PriceConfiguration) {
    const draft = draftFor(configuration);
    const price = Number(draft.price);
    if (!Number.isFinite(price) || price < 0)
      return setErrors((current) => ({ ...current, [configuration.id]: "Enter a valid price." }));
    if (!draft.reason.trim())
      return setErrors((current) => ({
        ...current,
        [configuration.id]: "Enter a reason for this change.",
      }));
    if (price === configuration.price)
      return setErrors((current) => ({
        ...current,
        [configuration.id]: "Enter a different price.",
      }));
    if (
      configuration.kind === "small_bike" &&
      item.large_bike_price !== null &&
      price >= item.large_bike_price
    )
      return setErrors((current) => ({
        ...current,
        [configuration.id]: "Small Bike pricing must remain lower than the Large Bike price.",
      }));
    if (configuration.kind === "large_bike" && price <= item.price)
      return setErrors((current) => ({
        ...current,
        [configuration.id]: "Large Bike pricing must be higher than the Small Bike price.",
      }));
    save.mutate({ item, configuration, price, reason: draft.reason.trim() });
  }
  function configurationHistory(item: PriceItem, configuration: PriceConfiguration) {
    return (history.data ?? []).filter(
      (record) => record.item_id === item.id && record.configuration_id === configuration.historyId,
    );
  }

  if (selected)
    return (
      <PriceEditor
        item={selected}
        configurations={configurationsFor(selected)}
        historyFor={configurationHistory}
        draftFor={draftFor}
        setDraft={setDraft}
        errors={errors}
        onSave={requestSave}
        saving={save.isPending}
        readOnly={archived}
        table={table}
        onBack={() => setSelected(null)}
      />
    );

  return (
    <Card className="border-border/70 bg-card/60">
      <CardContent className="overflow-x-auto p-0">
        <Table className="admin-data-table admin-balanced-table w-full">
          <TableHeader>
            <TableRow>
              <TableHead>{archived ? "Archived" : "Created"}</TableHead>
              <TableHead>{table === "services" ? "Service" : "Part / Accessory"}</TableHead>
              <TableHead>Category</TableHead>
              <TableHead className="text-center">
                {table === "services" ? "Bike Pricing" : "Pricing"}
              </TableHead>
              <TableHead className="text-center">Status</TableHead>
              <TableHead className="text-center">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(items.data ?? []).map((item) => (
              <TableRow key={item.id}>
                <TableCell>{formatDate(item.archived_at ?? item.created_at)}</TableCell>
                <TableCell>{item.name}</TableCell>
                <TableCell className="capitalize">{item.category}</TableCell>
                <TableCell className="text-center">
                  {table === "services" ? configurationsFor(item).length : "—"}
                </TableCell>
                <TableCell className="text-center">
                  <Badge
                    variant="outline"
                    className={
                      archived
                        ? "uppercase text-muted-foreground"
                        : `uppercase ${activeStatusTone(item.is_active)}`
                    }
                  >
                    {archived ? "Archived" : item.is_active ? "Active" : "Inactive"}
                  </Badge>
                </TableCell>
                <TableCell className="text-center">
                  <Button size="sm" variant="ghost" onClick={() => setSelected(item)}>
                    <Eye className="h-4 w-4" /> {archived ? "View" : "Manage"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!items.isLoading && (items.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No records found.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function PriceEditor({
  item,
  configurations,
  historyFor,
  draftFor,
  setDraft,
  errors,
  onSave,
  saving,
  readOnly,
  table,
  onBack,
}: {
  item: PriceItem;
  configurations: PriceConfiguration[];
  historyFor: (item: PriceItem, configuration: PriceConfiguration) => PriceHistory[];
  draftFor: (configuration: PriceConfiguration) => { price: string; reason: string };
  setDraft: (
    configuration: PriceConfiguration,
    changes: Partial<{ price: string; reason: string }>,
  ) => void;
  errors: Record<string, string>;
  onSave: (item: PriceItem, configuration: PriceConfiguration) => void;
  saving: boolean;
  readOnly: boolean;
  table: PriceTable;
  onBack: () => void;
}) {
  return (
    <Card className="border-border/70 bg-card/60">
      <CardContent className="space-y-5 p-4 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-display text-lg uppercase">{item.name}</p>
            <p className="text-sm text-muted-foreground">
              {readOnly
                ? "Archived pricing details."
                : table === "services"
                  ? "Update each bike category independently."
                  : "Update this price with a recorded reason."}
            </p>
          </div>
          <Button variant="outline" onClick={onBack} disabled={saving}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Button>
        </div>
        <div className="overflow-x-auto rounded-md border border-border/70">
          <Table className="admin-data-table min-w-[780px]">
            <TableHeader>
              <TableRow>
                <TableHead>Price Type</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Current Price</TableHead>
                {!readOnly && <TableHead>New Price</TableHead>}
                {!readOnly && <TableHead>Reason</TableHead>}
                {!readOnly && <TableHead>Action</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {configurations.map((configuration) => {
                const draft = draftFor(configuration);
                const latest = historyFor(item, configuration)[0];
                return (
                  <TableRow key={configuration.id}>
                    <TableCell>
                      {configuration.label}
                      <p className="mt-1 text-xs text-muted-foreground">
                        Last change: {latest ? formatDate(latest.created_at) : "—"}
                      </p>
                    </TableCell>
                    <TableCell>
                      {configuration.durationMinutes === null
                        ? "—"
                        : `${configuration.durationMinutes} min`}
                    </TableCell>
                    <TableCell className="text-primary">{formatPHP(configuration.price)}</TableCell>
                    {!readOnly && (
                      <TableCell>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          value={draft.price}
                          onChange={(event) =>
                            setDraft(configuration, { price: event.target.value })
                          }
                          aria-label={`New price for ${configuration.label}`}
                        />
                      </TableCell>
                    )}
                    {!readOnly && (
                      <TableCell>
                        <Input
                          value={draft.reason}
                          onChange={(event) =>
                            setDraft(configuration, { reason: event.target.value })
                          }
                          placeholder="Reason for change"
                          aria-label={`Reason for ${configuration.label}`}
                        />
                        <FieldError message={errors[configuration.id]} />
                      </TableCell>
                    )}
                    {!readOnly && (
                      <TableCell>
                        <Button
                          size="sm"
                          onClick={() => onSave(item, configuration)}
                          disabled={saving}
                        >
                          <Pencil className="h-4 w-4" /> Save
                        </Button>
                      </TableCell>
                    )}
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

function formatDate(value: string | null) {
  return value
    ? new Date(value).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })
    : "—";
}
