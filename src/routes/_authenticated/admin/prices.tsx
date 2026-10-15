import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Clock,
  Eye,
  History,
  Info,
  Loader2,
  Package,
  Pencil,
  RotateCcw,
  Tags,
  Wrench,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  AdminPage,
  ListCard,
  ListEmpty,
  ListError,
  ListLoading,
  ListToolbar,
  ResetFiltersButton,
  ToolbarFilters,
  ToolbarSearch,
} from "@/components/admin/data-list";
import { PageHeader } from "@/components/admin/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { cn } from "@/lib/utils";

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
type PriceDraft = { price: string; reason: string };

const ALL_CATEGORIES = "__all__";
const HISTORY_PREVIEW_COUNT = 5;

function PricesPage() {
  const [showArchives, setShowArchives] = useState(false);
  return (
    <AdminPage>
      <PageHeader
        title="Prices Management"
        description={
          showArchives
            ? "Review archived service and parts prices and their change history."
            : "Review and update Small Bike, Large Bike, and parts prices. Every change is recorded with a reason."
        }
        action={<PriceViewToggle archived={showArchives} onChange={setShowArchives} />}
      />
      <Tabs defaultValue="services">
        {/* Two equal tabs on phones, where a long label may wrap. */}
        <TabsList className="mb-4 grid w-full grid-cols-2 sm:inline-flex sm:w-auto">
          <TabsTrigger
            value="services"
            className="min-w-0 gap-2 self-stretch text-center leading-tight whitespace-normal"
          >
            <Wrench className="hidden size-4 shrink-0 sm:block" aria-hidden="true" /> Services
          </TabsTrigger>
          <TabsTrigger
            value="products"
            className="min-w-0 gap-2 self-stretch text-center leading-tight whitespace-normal"
          >
            <Package className="hidden size-4 shrink-0 sm:block" aria-hidden="true" /> Parts &
            Accessories
          </TabsTrigger>
        </TabsList>
        <TabsContent value="services">
          <PriceCatalog table="services" archived={showArchives} />
        </TabsContent>
        <TabsContent value="products">
          <PriceCatalog table="products" archived={showArchives} />
        </TabsContent>
      </Tabs>
    </AdminPage>
  );
}

function PriceViewToggle({
  archived,
  onChange,
}: {
  archived: boolean;
  onChange: (archived: boolean) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Price list"
      className="inline-flex rounded-md border border-border bg-card/60 p-1"
    >
      {[
        { value: false, label: "Active prices" },
        { value: true, label: "Archived" },
      ].map((option) => (
        <button
          key={option.label}
          type="button"
          aria-pressed={archived === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-9 rounded px-3 text-sm font-medium transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none md:h-8",
            archived === option.value
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:bg-secondary hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function PriceCatalog({ table, archived }: { table: PriceTable; archived: boolean }) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, PriceDraft>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedMessages, setSavedMessages] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState(ALL_CATEGORIES);

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
    setSelectedId(null);
    setDrafts({});
    setErrors({});
    setSavedMessages({});
    setSearch("");
    setCategory(ALL_CATEGORIES);
  }, [archived, table]);

  // Read the selected item from the latest query data so the editor shows the
  // saved price immediately after a change, not the value it was opened with.
  const selected = (items.data ?? []).find((item) => item.id === selectedId) ?? null;

  const categories = useMemo(
    () => Array.from(new Set((items.data ?? []).map((item) => item.category))).sort(),
    [items.data],
  );
  const normalizedSearch = search.trim().toLowerCase();
  const filteredItems = (items.data ?? []).filter(
    (item) =>
      (category === ALL_CATEGORIES || item.category === category) &&
      (!normalizedSearch || item.name.toLowerCase().includes(normalizedSearch)),
  );
  const latestChangeByItem = useMemo(() => {
    const latest = new Map<string, string>();
    for (const record of history.data ?? []) {
      if (!latest.has(record.item_id)) latest.set(record.item_id, record.created_at);
    }
    return latest;
  }, [history.data]);

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
    onSuccess: (_data, variables) => {
      const configurationId = variables.configuration.id;
      setDrafts(({ [configurationId]: _saved, ...current }) => current);
      setSavedMessages((current) => ({
        ...current,
        [configurationId]: `Saved. The price changed from ${formatPHP(variables.configuration.price)} to ${formatPHP(variables.price)}.`,
      }));
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

  function draftFor(configuration: PriceConfiguration): PriceDraft {
    return drafts[configuration.id] ?? { price: String(configuration.price), reason: "" };
  }
  function setDraft(configuration: PriceConfiguration, changes: Partial<PriceDraft>) {
    setDrafts((current) => ({
      ...current,
      [configuration.id]: { ...draftFor(configuration), ...changes },
    }));
    setErrors((current) => ({ ...current, [configuration.id]: "" }));
    setSavedMessages((current) => ({ ...current, [configuration.id]: "" }));
  }
  function resetDraft(configuration: PriceConfiguration) {
    setDrafts(({ [configuration.id]: _discarded, ...current }) => current);
    setErrors((current) => ({ ...current, [configuration.id]: "" }));
  }
  function requestSave(item: PriceItem, configuration: PriceConfiguration) {
    const draft = draftFor(configuration);
    const price = Number(draft.price);
    if (!draft.price.trim() || !Number.isFinite(price) || price < 0)
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
        historyLoading={history.isLoading}
        draftFor={draftFor}
        setDraft={setDraft}
        resetDraft={resetDraft}
        errors={errors}
        savedMessages={savedMessages}
        onSave={requestSave}
        saving={save.isPending}
        savingConfigurationId={save.isPending ? save.variables?.configuration.id : undefined}
        readOnly={archived}
        table={table}
        onBack={() => {
          setSelectedId(null);
          setSavedMessages({});
        }}
      />
    );

  const itemNoun = table === "services" ? "services" : "parts and accessories";
  const hasFilters = Boolean(normalizedSearch) || category !== ALL_CATEGORIES;
  const resetFilters = () => {
    setSearch("");
    setCategory(ALL_CATEGORIES);
  };
  const lastChangeLabel = (itemId: string) => {
    if (history.isLoading) return "…";
    const lastChange = latestChangeByItem.get(itemId);
    return lastChange ? formatDate(lastChange) : "No changes yet";
  };
  const editButton = (item: PriceItem) => (
    <Button
      size="sm"
      variant="outline"
      onClick={() => setSelectedId(item.id)}
      aria-label={`${archived ? "View prices for" : "Edit prices for"} ${item.name}`}
    >
      {archived ? <Eye /> : <Pencil />}
      {archived ? "View" : table === "services" ? "Edit prices" : "Edit price"}
    </Button>
  );

  return (
    <div>
      <ListToolbar
        summary={
          items.data && `Showing ${filteredItems.length} of ${items.data.length} ${itemNoun}`
        }
      >
        <ToolbarSearch
          value={search}
          onChange={setSearch}
          placeholder={table === "services" ? "Search services" : "Search parts and accessories"}
          label={table === "services" ? "Search services" : "Search parts and accessories"}
        />
        <ToolbarFilters>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger
              aria-label="Filter by category"
              className="col-span-2 w-full capitalize sm:w-52"
            >
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
              {categories.map((value) => (
                <SelectItem key={value} value={value} className="capitalize">
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasFilters && <ResetFiltersButton onClick={resetFilters} />}
        </ToolbarFilters>
      </ListToolbar>

      <ListCard>
        {filteredItems.length > 0 && (
          <>
            {/* Phones and tablets: one card per item, so nothing scrolls sideways
                  next to the admin sidebar. */}
            <ul className="divide-y divide-border/70 lg:hidden">
              {filteredItems.map((item) => (
                <li
                  key={item.id}
                  className="grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-x-6"
                >
                  <div className="min-w-0 space-y-2.5">
                    <div className="flex items-start justify-between gap-3">
                      <ItemName item={item} archived={archived} />
                      <span className="sm:hidden">
                        <StatusBadge archived={archived} active={item.is_active} />
                      </span>
                    </div>
                    <dl className="grid grid-cols-2 gap-3 text-sm sm:flex sm:flex-wrap sm:gap-x-8">
                      {table === "services" ? (
                        <>
                          <PriceFact
                            label="Small Bike"
                            price={item.price}
                            durationMinutes={item.duration_minutes}
                          />
                          <PriceFact
                            label="Large Bike"
                            price={item.large_bike_price}
                            durationMinutes={item.large_bike_duration_minutes}
                          />
                        </>
                      ) : (
                        <PriceFact label="Price" price={item.price} durationMinutes={null} />
                      )}
                    </dl>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 sm:flex-col sm:items-end">
                    <span className="hidden sm:block">
                      <StatusBadge archived={archived} active={item.is_active} />
                    </span>
                    <p className="text-xs text-muted-foreground sm:text-right">
                      Last price change: {lastChangeLabel(item.id)}
                    </p>
                    {editButton(item)}
                  </div>
                </li>
              ))}
            </ul>

            {/* Laptops and desktops: a compact table. */}
            <Table className="hidden w-full table-fixed lg:table">
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-5">
                    {table === "services" ? "Service" : "Part / Accessory"}
                  </TableHead>
                  {table === "services" ? (
                    <>
                      <TableHead className="w-32 text-right">Small Bike</TableHead>
                      <TableHead className="w-32 text-right">Large Bike</TableHead>
                    </>
                  ) : (
                    <TableHead className="w-36 text-right">Price</TableHead>
                  )}
                  <TableHead className="hidden w-44 xl:table-cell">Last price change</TableHead>
                  <TableHead className="w-28 text-center">Status</TableHead>
                  <TableHead className="w-40 pr-5 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((item) => (
                  <TableRow key={item.id} className="align-top [&>td]:py-3">
                    <TableCell className="pl-5">
                      <ItemName item={item} archived={archived} />
                    </TableCell>
                    {table === "services" ? (
                      <>
                        <TableCell className="text-right">
                          <PriceSummary
                            price={item.price}
                            durationMinutes={item.duration_minutes}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <PriceSummary
                            price={item.large_bike_price}
                            durationMinutes={item.large_bike_duration_minutes}
                          />
                        </TableCell>
                      </>
                    ) : (
                      <TableCell className="text-right">
                        <PriceSummary price={item.price} durationMinutes={null} />
                      </TableCell>
                    )}
                    <TableCell className="hidden text-xs text-muted-foreground xl:table-cell">
                      {lastChangeLabel(item.id)}
                    </TableCell>
                    <TableCell className="text-center">
                      <StatusBadge archived={archived} active={item.is_active} />
                    </TableCell>
                    <TableCell className="pr-5 text-right">{editButton(item)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </>
        )}

        {items.isLoading && <ListLoading label="Loading prices" />}
        {items.isError && (
          <ListError message="Prices could not be loaded." onRetry={() => void items.refetch()} />
        )}
        {items.isSuccess && filteredItems.length === 0 && (
          <ListEmpty
            icon={Tags}
            title={
              hasFilters
                ? `No ${itemNoun} match your search.`
                : archived
                  ? `There are no archived ${itemNoun}.`
                  : `No ${itemNoun} yet.`
            }
            description={hasFilters ? "Try a different search or category." : undefined}
            action={hasFilters ? <ResetFiltersButton onClick={resetFilters} /> : undefined}
          />
        )}
      </ListCard>
    </div>
  );
}

function ItemName({ item, archived }: { item: PriceItem; archived: boolean }) {
  return (
    <div className="min-w-0">
      <p className="font-medium break-words">{item.name}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        <span className="capitalize">{item.category}</span> · {archived ? "Archived" : "Added"}{" "}
        {formatShortDate(item.archived_at ?? item.created_at)}
      </p>
    </div>
  );
}

function StatusBadge({ archived, active }: { archived: boolean; active: boolean }) {
  return (
    <Badge
      variant="outline"
      className={
        archived ? "uppercase text-muted-foreground" : `uppercase ${activeStatusTone(active)}`
      }
    >
      {archived ? "Archived" : active ? "Active" : "Inactive"}
    </Badge>
  );
}

function PriceFact({
  label,
  price,
  durationMinutes,
}: {
  label: string;
  price: number | null;
  durationMinutes: number | null;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="mt-0.5">
        {price === null ? (
          <span className="text-muted-foreground">Not set</span>
        ) : (
          <>
            <span className="font-medium tabular-nums">{formatPHP(price)}</span>
            {durationMinutes !== null && (
              <span className="text-xs text-muted-foreground"> · {durationMinutes} min</span>
            )}
          </>
        )}
      </dd>
    </div>
  );
}

function PriceSummary({
  price,
  durationMinutes,
}: {
  price: number | null;
  durationMinutes: number | null;
}) {
  if (price === null) return <span className="text-xs text-muted-foreground">Not set</span>;
  return (
    <span className="inline-flex flex-col items-end">
      <span className="font-medium text-foreground tabular-nums">{formatPHP(price)}</span>
      {durationMinutes !== null && (
        <span className="text-xs text-muted-foreground">{durationMinutes} min</span>
      )}
    </span>
  );
}

function PriceEditor({
  item,
  configurations,
  historyFor,
  historyLoading,
  draftFor,
  setDraft,
  resetDraft,
  errors,
  savedMessages,
  onSave,
  saving,
  savingConfigurationId,
  readOnly,
  table,
  onBack,
}: {
  item: PriceItem;
  configurations: PriceConfiguration[];
  historyFor: (item: PriceItem, configuration: PriceConfiguration) => PriceHistory[];
  historyLoading: boolean;
  draftFor: (configuration: PriceConfiguration) => PriceDraft;
  setDraft: (configuration: PriceConfiguration, changes: Partial<PriceDraft>) => void;
  resetDraft: (configuration: PriceConfiguration) => void;
  errors: Record<string, string>;
  savedMessages: Record<string, string>;
  onSave: (item: PriceItem, configuration: PriceConfiguration) => void;
  saving: boolean;
  savingConfigurationId: string | undefined;
  readOnly: boolean;
  table: PriceTable;
  onBack: () => void;
}) {
  return (
    <div className="space-y-5">
      <Button variant="ghost" size="sm" onClick={onBack} disabled={saving} className="-ml-2">
        <ArrowLeft /> Back to {table === "services" ? "services" : "parts & accessories"}
      </Button>

      <Card className="border-border/70 bg-card/60">
        <CardContent className="flex flex-wrap items-start justify-between gap-4 p-4 sm:p-6">
          <div className="min-w-0">
            <p className="text-xs tracking-widest text-muted-foreground uppercase">
              {table === "services" ? "Service" : "Part / Accessory"} ·{" "}
              <span className="capitalize">{item.category}</span>
            </p>
            <h2 className="mt-1 font-display text-2xl break-words uppercase">{item.name}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {readOnly
                ? "Archived pricing details. Prices can't be changed here."
                : table === "services"
                  ? "Each bike size is priced separately. Every change is saved with its reason in the price history."
                  : "Every price change is saved with its reason in the price history."}
            </p>
          </div>
          <Badge
            variant="outline"
            className={
              readOnly
                ? "uppercase text-muted-foreground"
                : `uppercase ${activeStatusTone(item.is_active)}`
            }
          >
            {readOnly ? "Archived" : item.is_active ? "Active" : "Inactive"}
          </Badge>
        </CardContent>
      </Card>

      {table === "services" && !readOnly && (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
          {configurations.length > 1
            ? "The Small Bike price must stay lower than the Large Bike price."
            : "This service has no Large Bike price. You can add one by editing the service on the Services page."}
        </p>
      )}

      <div className={cn("grid gap-5", configurations.length > 1 && "xl:grid-cols-2")}>
        {configurations.map((configuration) => (
          <PriceConfigurationCard
            key={configuration.id}
            configuration={configuration}
            history={historyFor(item, configuration)}
            historyLoading={historyLoading}
            draft={draftFor(configuration)}
            onDraftChange={(changes) => setDraft(configuration, changes)}
            onReset={() => resetDraft(configuration)}
            error={errors[configuration.id]}
            savedMessage={savedMessages[configuration.id]}
            onSave={() => onSave(item, configuration)}
            saving={saving}
            isSaving={savingConfigurationId === configuration.id}
            readOnly={readOnly}
          />
        ))}
      </div>
    </div>
  );
}

function PriceConfigurationCard({
  configuration,
  history,
  historyLoading,
  draft,
  onDraftChange,
  onReset,
  error,
  savedMessage,
  onSave,
  saving,
  isSaving,
  readOnly,
}: {
  configuration: PriceConfiguration;
  history: PriceHistory[];
  historyLoading: boolean;
  draft: PriceDraft;
  onDraftChange: (changes: Partial<PriceDraft>) => void;
  onReset: () => void;
  error: string | undefined;
  savedMessage: string | undefined;
  onSave: () => void;
  saving: boolean;
  isSaving: boolean;
  readOnly: boolean;
}) {
  const [showAllHistory, setShowAllHistory] = useState(false);
  const priceInputId = `${configuration.id}-new-price`;
  const reasonInputId = `${configuration.id}-reason`;
  const latest = history[0];
  const draftPrice = Number(draft.price);
  const dirty = draft.price !== String(configuration.price) || draft.reason !== "";
  const difference =
    draft.price.trim() && Number.isFinite(draftPrice) && draftPrice >= 0
      ? draftPrice - configuration.price
      : 0;
  const visibleHistory = showAllHistory ? history : history.slice(0, HISTORY_PREVIEW_COUNT);

  return (
    <Card className="border-border/70 bg-card/60">
      <CardContent className="space-y-5 p-4 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h3 className="font-display text-lg tracking-wide uppercase">{configuration.label}</h3>
            {configuration.durationMinutes !== null && (
              <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
                <Clock className="size-3.5" aria-hidden="true" /> {configuration.durationMinutes}{" "}
                min service time
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Last change: {latest ? formatDate(latest.created_at) : "No changes recorded yet"}
            </p>
          </div>
          <div className="text-left sm:text-right">
            <p className="text-xs tracking-widest text-muted-foreground uppercase">Current price</p>
            <p className="font-display text-3xl text-primary tabular-nums">
              {formatPHP(configuration.price)}
            </p>
          </div>
        </div>

        {!readOnly && (
          <form
            noValidate
            className="space-y-4 rounded-lg border border-border/70 bg-background/40 p-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSave();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
              <div className="space-y-1.5">
                <Label htmlFor={priceInputId}>New price</Label>
                <div className="relative">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-sm text-muted-foreground"
                  >
                    ₱
                  </span>
                  <Input
                    id={priceInputId}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={draft.price}
                    onChange={(event) => onDraftChange({ price: event.target.value })}
                    aria-invalid={Boolean(error)}
                    className="pl-7 tabular-nums"
                  />
                </div>
                {difference !== 0 && (
                  <p
                    className={cn(
                      "text-xs tabular-nums",
                      difference > 0
                        ? "text-emerald-600 dark:text-emerald-400"
                        : "text-destructive",
                    )}
                  >
                    {difference > 0 ? "+" : "−"}
                    {formatPHP(Math.abs(difference))}
                    {configuration.price > 0 &&
                      ` (${difference > 0 ? "+" : "−"}${Math.abs((difference / configuration.price) * 100).toFixed(1)}%)`}{" "}
                    from current price
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={reasonInputId}>Reason for change</Label>
                <Input
                  id={reasonInputId}
                  value={draft.reason}
                  onChange={(event) => onDraftChange({ reason: event.target.value })}
                  placeholder="e.g. Updated supplier cost"
                  aria-invalid={Boolean(error)}
                />
              </div>
            </div>
            <FieldError message={error} />
            {savedMessage && (
              <p
                role="status"
                className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400"
              >
                <Check className="size-3.5 shrink-0" aria-hidden="true" /> {savedMessage}
              </p>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
              {dirty && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onReset}
                  disabled={saving}
                  className="w-full sm:w-auto"
                >
                  <RotateCcw /> Discard changes
                </Button>
              )}
              <Button type="submit" disabled={saving} className="w-full sm:w-auto">
                {isSaving ? <Loader2 className="animate-spin" /> : <Check />}
                {isSaving ? "Saving…" : "Save price"}
              </Button>
            </div>
          </form>
        )}

        <div>
          <h4 className="flex items-center gap-2 font-sans text-xs font-semibold tracking-widest text-muted-foreground uppercase">
            <History className="size-3.5" aria-hidden="true" /> Price history
          </h4>
          {historyLoading ? (
            <p className="mt-2 text-sm text-muted-foreground">Loading history…</p>
          ) : history.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No price changes recorded yet.</p>
          ) : (
            <>
              <ol className="mt-2 divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
                {visibleHistory.map((record) => (
                  <li key={record.id} className="space-y-0.5 px-3 py-2.5 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                      <span className="tabular-nums">
                        <span className="text-muted-foreground line-through">
                          {formatPHP(record.old_price)}
                        </span>{" "}
                        <span aria-label="changed to">→</span>{" "}
                        <span className="font-medium text-foreground">
                          {formatPHP(record.new_price)}
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDate(record.created_at)}
                      </span>
                    </div>
                    {record.reason && (
                      <p className="break-words text-muted-foreground">{record.reason}</p>
                    )}
                    {record.changed_by_email && (
                      <p className="text-xs break-all text-muted-foreground">
                        by {record.changed_by_email}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
              {history.length > HISTORY_PREVIEW_COUNT && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="mt-1 h-auto px-0 md:h-auto"
                  onClick={() => setShowAllHistory((current) => !current)}
                >
                  {showAllHistory ? "Show fewer changes" : `Show all ${history.length} changes`}
                </Button>
              )}
            </>
          )}
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

function formatShortDate(value: string | null) {
  return value
    ? new Date(value).toLocaleDateString("en-PH", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })
    : "—";
}
