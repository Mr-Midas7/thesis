import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  CalendarCheck,
  Clock,
  ExternalLink,
  MapPin,
  Phone,
  ShieldCheck,
  Wrench,
} from "lucide-react";

import famImage from "@/assets/fam-image.jpg?url";
import { ProductCard } from "@/components/site/product-card";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { SHOP } from "@/lib/shop";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Fake Rider Motorparts | Motorcycle Service Booking" },
      {
        name: "description",
        content:
          "Book motorcycle service online with Fake Rider Motorparts. Premium parts, accessories and race-grade mechanics with 48-hour advance scheduling.",
      },
      { property: "og:title", content: "Fake Rider Motorparts" },
      {
        property: "og:description",
        content:
          "Premium motorparts, accessories and race-grade motorcycle service. Book your slot online.",
      },
    ],
  }),
  component: Home,
});

function Home() {
  const featured = useQuery({
    queryKey: ["featured-products"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("*")
        .eq("is_active", true)
        .eq("is_archived", false)
        .order("is_featured", { ascending: false })
        .order("sort_order")
        .limit(8);
      if (error) throw error;
      return Array.from(new Map((data ?? []).map((p) => [p.name.trim(), p])).values());
    },
  });

  const services = useQuery({
    queryKey: ["home-services"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("services")
        .select("*")
        .eq("is_active", true)
        .eq("is_archived", false)
        .order("sort_order")
        .limit(6);
      if (error) throw error;
      return Array.from(new Map((data ?? []).map((s) => [s.name.trim(), s])).values());
    },
  });

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main>
        <section className="relative isolate overflow-hidden border-y border-border/50 bg-card">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-cover bg-center"
            style={{ backgroundImage: "url('/shopfront.jpg')" }}
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-r from-black/90 via-black/75 to-black/25"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/10"
          />

          <div className="site-container relative z-10 py-20 md:py-28">
            <div className="max-w-2xl">
              <Badge
                className="mb-4 border-white/30 bg-black/25 text-accent uppercase"
                variant="outline"
              >
                Local Pit Stop &middot; Philippines
              </Badge>
              <h1 className="font-display text-5xl leading-[0.95] font-extrabold text-white uppercase md:text-7xl">
                Ride Hard.
                <span className="text-gradient-race block">Service Harder.</span>
              </h1>
              <p className="mt-5 max-w-lg text-base text-white/85">
                {SHOP.tagline}. Reserve your slot online, get a reference code instantly, and let
                our pit crew take care of the rest.
              </p>
              <div className="mt-7 flex flex-wrap gap-3">
                <Button asChild size="lg" className="font-display tracking-wide uppercase">
                  <Link to="/book">
                    <CalendarCheck /> Book an appointment
                  </Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="font-display tracking-wide uppercase"
                >
                  <Link to="/my-appointment">Track my booking</Link>
                </Button>
              </div>
              <div className="mt-8 grid gap-3 text-sm text-white/85 sm:grid-cols-3">
                <span className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" /> Certified mechanics
                </span>
                <span className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-primary" /> 48-hour advance booking
                </span>
                <span className="flex items-center gap-2">
                  <Wrench className="h-4 w-4 text-primary" /> Genuine parts
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="border-y border-border/70 bg-card/40">
          <div className="site-container grid gap-4 py-6 md:py-7 sm:grid-cols-3">
            <InfoTile
              icon={<MapPin className="h-5 w-5 text-primary" />}
              title="Shop location"
              value={SHOP.address}
              href="https://www.google.com/maps/search/?api=1&query=Fake+Rider+Motoparts+and+Accessories,+Purok+Bangkal+Sta.+Cruz,+Baclayon,+Bohol"
            />
            <InfoTile
              icon={<Clock className="h-5 w-5 text-primary" />}
              title="Open hours"
              value={SHOP.hours}
            />
            <InfoTile
              icon={<Phone className="h-5 w-5 text-primary" />}
              title="Call or text"
              value={SHOP.phone}
            />
          </div>
        </section>

        <section className="site-container py-8 md:py-10">
          <SectionHeading
            eyebrow="Shop showcase"
            title="Featured parts & accessories"
            action={
              <Link to="/shop" className="text-sm text-primary hover:underline">
                View full shop
              </Link>
            }
          />
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {featured.data?.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
            {featured.isLoading &&
              Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-72 animate-pulse rounded-xl border border-border bg-card/60"
                />
              ))}
          </div>
        </section>

        <section className="border-y border-border/70 bg-card/30">
          <div className="site-container py-8 md:py-10">
            <SectionHeading
              eyebrow="Service menu"
              title="What our pit crew can do"
              action={
                <Link to="/services" className="text-sm text-primary hover:underline">
                  All services
                </Link>
              }
            />
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {services.data?.map((s) => (
                <Card key={s.id} className="border-border/70 bg-background/60">
                  <CardContent className="p-5">
                    <h3 className="font-display text-lg tracking-wide uppercase">{s.name}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">{s.description}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </section>

        <section className="site-container grid items-center gap-10 pt-8 pb-4 md:grid-cols-2 md:pt-10 md:pb-6">
          <img
            src={famImage}
            alt="The Fake Rider Motorparts riding family at a local motocross event"
            loading="lazy"
            className="w-full rounded-2xl border border-border/70 object-cover shadow-xl"
          />
          <div>
            <SectionHeading
              eyebrow="Our riders family"
              title="More than a shop, a riding community"
            />
            <p className="text-muted-foreground">
              From weekend trail rides to local motocross events, Fake Rider Motorparts grew with
              the riders it serves. Every unit that rolls into our garage gets the same attention we
              give our own race bikes.
            </p>
            <p className="mt-4 text-muted-foreground">
              We welcome everyday commuters, long-distance riders, and weekend enthusiasts who
              simply want a shop they can trust. Our crew listens to what your motorcycle needs,
              explains the work in clear terms, and helps you choose the right service or part for
              the road ahead.
            </p>
            <p className="mt-4 text-muted-foreground">
              From quick oil changes and brake checks to repairs, upgrades, and riding essentials,
              we work carefully and honestly on every unit that comes through our doors. The goal is
              simple: keep your ride reliable, safe, and ready for the next trip with the people who
              matter to you.
            </p>
            <p className="mt-4 text-muted-foreground">
              Our shop is also a place to swap stories, ask questions, and meet people who share the
              same love for two wheels. Whether you are preparing for a local ride, restoring a
              trusted bike, or maintaining your daily motorcycle, you are always welcome here.
            </p>
            <p className="mt-4 text-muted-foreground">
              Drop by, join a ride, or reserve your service slot online and skip the waiting line.
              Fake Rider Motorparts is ready to help you enjoy every kilometre with confidence.
            </p>
            <Button asChild className="mt-6 font-display tracking-wide uppercase">
              <Link to="/book">Reserve your slot</Link>
            </Button>
          </div>
        </section>
      </main>

      <SiteFooter className="mt-4 md:mt-6" />
    </div>
  );
}

function InfoTile({
  icon,
  title,
  value,
  href,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  href?: string;
}) {
  const content = (
    <>
      {icon}
      <div>
        <p className="flex items-center gap-1 text-xs tracking-widest text-muted-foreground uppercase">
          {title}
          {href && <ExternalLink className="h-3 w-3" />}
        </p>
        <p className="text-sm text-foreground">{value}</p>
      </div>
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-start gap-3 rounded-lg border border-border/70 bg-background/50 p-4 text-left transition-colors hover:border-primary/50 hover:bg-background/80"
      >
        {content}
      </a>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-lg border border-border/70 bg-background/50 p-4">
      {content}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string;
  title: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs tracking-[0.3em] text-accent uppercase">{eyebrow}</p>
        <h2 className="font-display text-3xl font-bold uppercase md:text-4xl">{title}</h2>
      </div>
      {action}
    </div>
  );
}
