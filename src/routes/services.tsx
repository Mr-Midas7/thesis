import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Clock } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/services")({
  head: () => ({
    meta: [
      { title: "Motorcycle Services & Price List | Fake Rider" },
      {
        name: "description",
        content:
          "PMS, change oil, suspension tuning, brakes, tires and engine work with transparent peso pricing at Fake Rider Motorparts.",
      },
      { property: "og:title", content: "Services & Prices | Fake Rider Motorparts" },
      {
        property: "og:description",
        content: "Transparent service pricing for every motorcycle job we handle.",
      },
    ],
  }),
  component: ServicesPage,
});

function ServicesPage() {
  const [activeCategory, setActiveCategory] = useState("all");
  const services = useQuery({
    queryKey: ["services"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("services")
        .select("*")
        .eq("is_active", true)
        .eq("is_archived", false)
        .order("sort_order");
      if (error) throw error;
      return Array.from(new Map((data ?? []).map((s) => [s.name.trim(), s])).values());
    },
  });

  const categories = ["all", ...new Set(services.data?.map((s) => s.category))];
  const filtered = services.data?.filter((s) => {
    if (activeCategory === "all") return true;
    return s.category === activeCategory;
  });

  return (
    <div className="min-h-screen">
      <SiteHeader />
      <main className="site-container py-12">
        <p className="text-xs tracking-[0.3em] text-accent uppercase">Service menu</p>
        <h1 className="font-display text-4xl font-bold uppercase md:text-5xl">Services & Prices</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Starting rates below. Final quotation depends on parts used and the actual condition of
          your unit.
        </p>

        <div className="mt-8">
          <div className="mb-4">
            <ToggleGroup
              type="single"
              variant="outline"
              value={activeCategory}
              onValueChange={setActiveCategory}
              className="flex w-full flex-wrap justify-start gap-1.5"
            >
              {categories.map((cat) => {
                const count = services.data?.filter(
                  (s) => cat === "all" || s.category === cat,
                ).length;
                return (
                  <ToggleGroupItem key={cat} value={cat} className="capitalize">
                    {cat === "all" ? "All" : cat}
                    <Badge
                      variant={activeCategory === cat ? "default" : "secondary"}
                      className="ml-1.5 h-5 px-1.5 text-xs font-medium"
                    >
                      {count}
                    </Badge>
                  </ToggleGroupItem>
                );
              })}
            </ToggleGroup>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered?.map((s) => (
              <Card key={s.id} className="border-border/70 bg-card/60">
                <CardContent className="p-5">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className="font-display text-[0.55rem] font-medium uppercase"
                    >
                      {s.category}
                    </Badge>
                    <h2 className="font-display text-lg tracking-wide uppercase">{s.name}</h2>
                  </div>
                  <ExpandableServiceDescription description={s.description} serviceName={s.name} />
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        <div className="mt-12 rounded-2xl border border-primary/30 bg-primary/5 p-8 text-center">
          <h2 className="font-display text-2xl uppercase">Ready to book your slot?</h2>
          <p className="mt-2 text-muted-foreground">
            Schedules open 48 hours ahead. Reserve now and get your reference code.
          </p>
          <Button asChild size="lg" className="mt-5 font-display tracking-wide uppercase">
            <Link to="/book">Book an appointment</Link>
          </Button>
        </div>
      </main>
      <SiteFooter />
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
  const details = description?.trim() ?? "";

  useEffect(() => {
    const element = descriptionRef.current;
    if (!element || !details) return;

    const checkOverflow = () => {
      if (!expanded) setCanExpand(element.scrollHeight > element.clientHeight + 1);
    };

    checkOverflow();
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(checkOverflow);
    observer.observe(element);
    return () => observer.disconnect();
  }, [details, expanded]);

  if (!details) return null;

  return (
    <div className="mt-2 text-sm text-muted-foreground">
      <p ref={descriptionRef} className={expanded ? "break-words" : "line-clamp-3 break-words"}>
        {details}
      </p>
      {canExpand && (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="mt-1 h-auto p-0 text-sm"
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
