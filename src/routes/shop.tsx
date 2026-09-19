import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import { ProductCard } from "@/components/site/product-card";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/shop")({
  head: () => ({
    meta: [
      { title: "Shop Parts & Accessories | Fake Rider" },
      {
        name: "description",
        content:
          "Browse genuine motorcycle parts and riding accessories available at Fake Rider Motorparts.",
      },
      { property: "og:title", content: "Fake Rider Motorparts Shop" },
      {
        property: "og:description",
        content: "Parts and accessories available in store.",
      },
    ],
  }),
  component: ShopPage,
});

const tabs = [
  { value: "all", label: "All" },
  { value: "part", label: "Parts" },
  { value: "accessory", label: "Accessories" },
];

function ShopPage() {
  const [tab, setTab] = useState("all");
  const [term, setTerm] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  const products = useQuery({
    queryKey: ["products"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("*")
        .eq("is_active", true)
        .eq("is_archived", false)
        .in("category", ["part", "accessory"])
        .order("sort_order");
      if (error) throw error;
      return data ?? [];
    },
  });

  const normalizedSearchTerm = searchTerm.trim().toLocaleLowerCase();
  const list = useMemo(
    () =>
      (products.data ?? []).filter(
        (product) =>
          (tab === "all" || product.category === tab) &&
          (normalizedSearchTerm === "" ||
            `${product.name} ${product.brand ?? ""} ${product.description ?? ""}`
              .toLocaleLowerCase()
              .includes(normalizedSearchTerm)),
      ),
    [normalizedSearchTerm, products.data, tab],
  );

  function clearSearch() {
    setTerm("");
    setSearchTerm("");
  }

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="site-container py-12">
        <p className="text-xs tracking-[0.3em] text-accent uppercase">Shop showcase</p>
        <h1 className="font-display text-4xl font-bold uppercase md:text-5xl">
          Parts & Accessories
        </h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Everything we stock in the garage. Prices are in Philippine peso and may change without
          prior notice &mdash; use Reserve via Messenger on an item card to ask the shop to hold it.
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList>
              {tabs.map((t) => (
                <TabsTrigger key={t.value} value={t.value} className="font-display uppercase">
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <form
            className="flex w-full gap-2 sm:w-auto"
            onSubmit={(event) => {
              event.preventDefault();
              setSearchTerm(term);
            }}
          >
            <Input
              value={term}
              onChange={(event) => {
                const value = event.target.value;
                setTerm(value);
                if (!value.trim()) setSearchTerm("");
              }}
              placeholder="Search item or brand"
              aria-label="Search shop items"
              className="min-w-0 flex-1 sm:w-64"
            />
            <Button type="submit" className="font-display uppercase">
              Search
            </Button>
            {(term || searchTerm) && (
              <Button type="button" variant="outline" onClick={clearSearch}>
                Clear
              </Button>
            )}
          </form>
        </div>

        <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {list.map((p) => (
            <ProductCard key={p.id} product={p} />
          ))}
        </div>
        {!products.isLoading && list.length === 0 && (
          <p className="py-16 text-center text-muted-foreground">No items match your search.</p>
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
