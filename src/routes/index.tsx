import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  BadgeCheck,
  CalendarCheck,
  CalendarDays,
  Clock,
  ExternalLink,
  Facebook,
  ListChecks,
  MapPin,
  Phone,
  ShieldCheck,
  Smartphone,
  Wrench,
} from "lucide-react";

import famImage from "@/assets/fam-image.jpg?url";
import { ProductCard } from "@/components/site/product-card";
import { ServiceBookingRow } from "@/components/site/service-booking-row";
import { ShopHours, SiteFooter } from "@/components/site/site-footer";
import { SiteHeader } from "@/components/site/site-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { SHOP } from "@/lib/shop";
import { cn } from "@/lib/utils";

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

const BOOKING_STEPS = [
  {
    icon: ListChecks,
    title: "Choose your services",
    text: "Pick your motorcycle and the work you need. You see the estimated price before you submit.",
  },
  {
    icon: CalendarDays,
    title: "Pick a date and time",
    text: "Choose any open slot at least 48 hours ahead, Monday to Saturday.",
  },
  {
    icon: BadgeCheck,
    title: "Get your reference code",
    text: "You get it right away. We confirm by email and text, and you can track or reschedule online.",
  },
];

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
      const { data, error, count } = await supabase
        .from("services")
        .select("id,name,description", { count: "exact" })
        .eq("is_active", true)
        .eq("is_archived", false)
        .order("sort_order")
        .limit(6);
      if (error) throw error;
      return {
        rows: Array.from(new Map((data ?? []).map((s) => [s.name.trim(), s])).values()),
        total: count ?? 0,
      };
    },
  });

  return (
    <div className="min-h-screen">
      <SiteHeader />

      <main>
        <section className="relative isolate overflow-hidden border-b border-border/50 bg-neutral-900">
          {/* Phones get the garage and the mechanic at work; wider screens get the right
              two-thirds of the shopfront, so nothing busy sits behind the headline.
              License plates are blurred in both. */}
          <picture>
            <source media="(max-width: 767px)" srcSet="/hero-phone.webp" />
            <img
              src="/hero-wide.webp"
              alt=""
              aria-hidden="true"
              fetchPriority="high"
              className="absolute inset-0 -z-10 h-full w-full object-cover md:object-[75%_65%]"
            />
          </picture>
          {/* Phones: an even shade, since the text spans the full width. Wider screens:
              dark behind the text and light on the right, so the photo reads as daytime. */}
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 bg-black/60 md:bg-transparent md:bg-gradient-to-r md:from-black/85 md:via-black/55 md:via-45% md:to-black/5"
          />
          <div
            aria-hidden="true"
            className="absolute inset-0 -z-10 bg-gradient-to-t from-black/40 via-transparent to-transparent"
          />

          <div className="site-container py-16 md:py-28">
            <div className="max-w-2xl">
              <Badge
                className="mb-4 border-white/30 bg-black/40 text-orange-400 uppercase"
                variant="outline"
              >
                Local Pit Stop &middot; Philippines
              </Badge>
              <h1 className="font-display text-5xl leading-[0.95] font-extrabold text-white uppercase md:text-7xl">
                Ride Hard.
                <span className="text-gradient-race block">Service Harder.</span>
              </h1>
              <p className="mt-5 max-w-lg text-base text-white/85">
                {SHOP.tagline}. Book your service online in a few minutes, get a reference code
                right away, and let our pit crew take care of the rest.
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
              <ul className="mt-8 grid gap-3 text-sm text-white/85 sm:grid-cols-3">
                <li className="flex items-center gap-2">
                  <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" /> Certified
                  mechanics
                </li>
                <li className="flex items-center gap-2">
                  <Wrench className="h-4 w-4 text-primary" aria-hidden="true" /> Genuine parts
                </li>
                <li className="flex items-center gap-2">
                  <Smartphone className="h-4 w-4 text-primary" aria-hidden="true" /> Book and track
                  online
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section
          aria-label="Visit or contact the shop"
          className="border-b border-border/70 bg-card/40"
        >
          <div className="site-container grid gap-3 py-5 sm:grid-cols-3 sm:gap-4 md:py-6">
            <InfoTile
              icon={MapPin}
              title="Shop location"
              value={SHOP.address}
              href={SHOP.mapsUrl}
              external
            />
            <InfoTile icon={Clock} title="Open hours" value={<ShopHours />} />
            <InfoTile
              icon={Phone}
              title="Call or text"
              value={SHOP.phone}
              href={`tel:${SHOP.phone.replace(/\s/g, "")}`}
            />
          </div>
        </section>

        <section className="site-container py-7 md:py-9">
          <SectionHeading
            eyebrow="Service menu"
            title="What our pit crew can do"
            description="Pick a service to book it. You see the price for your motorcycle on the booking form."
          />
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {services.data?.rows.map((service, index) => (
              <Card
                key={service.id}
                // Four on phones; the link below leads to the rest.
                className={cn("border-border/70 bg-card/70", index >= 4 && "max-md:hidden")}
              >
                <CardContent className="flex h-full flex-col p-5">
                  <h3 className="font-display text-lg tracking-wide uppercase">{service.name}</h3>
                  {service.description && (
                    <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                      {service.description}
                    </p>
                  )}
                  <ServiceBookingRow service={service} />
                </CardContent>
              </Card>
            ))}
            {services.isLoading &&
              Array.from({ length: 6 }).map((_, i) => (
                <div
                  key={i}
                  className="h-40 animate-pulse rounded-xl border border-border/70 bg-card/60"
                />
              ))}
          </div>
          {services.isError && (
            <p className="text-sm text-muted-foreground">
              We couldn't load the service list right now.
            </p>
          )}
          <SectionLink to="/services">
            {services.data?.total ? `See all ${services.data.total} services` : "See all services"}
          </SectionLink>
        </section>

        <section className="border-y border-border/70 bg-card/30">
          <div className="site-container py-7 md:py-9">
            <SectionHeading eyebrow="Booking" title="How booking works" />
            <ol className="grid gap-4 md:grid-cols-3 md:gap-6">
              {BOOKING_STEPS.map((step, index) => (
                <li key={step.title} className="flex gap-4">
                  <span className="relative grid size-11 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
                    <step.icon className="size-5" aria-hidden="true" />
                    <span className="absolute -top-1 -right-1 grid size-5 place-items-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
                      {index + 1}
                    </span>
                  </span>
                  <div>
                    <h3 className="font-display text-lg tracking-wide uppercase">{step.title}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{step.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="font-display tracking-wide uppercase">
                <Link to="/book">
                  <CalendarCheck /> Book an appointment
                </Link>
              </Button>
            </div>
          </div>
        </section>

        <section className="site-container py-7 md:py-9">
          <SectionHeading
            eyebrow="Shop showcase"
            title="Featured parts & accessories"
            description="Reserve an item through Messenger and pick it up at the shop."
          />
          {/* Four items on phones and tablets, eight on wide screens. */}
          <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
            {featured.data?.map((product, index) => (
              <div key={product.id} className={cn(index >= 4 && "hidden lg:block")}>
                <ProductCard product={product} compact />
              </div>
            ))}
            {featured.isLoading &&
              Array.from({ length: 4 }).map((_, i) => (
                <div
                  key={i}
                  className="h-64 animate-pulse rounded-xl border border-border/70 bg-card/60 sm:h-72"
                />
              ))}
          </div>
          {featured.isError && (
            <p className="text-sm text-muted-foreground">
              We couldn't load the featured items right now.
            </p>
          )}
          <SectionLink to="/shop">View the full shop</SectionLink>
        </section>

        <section className="border-t border-border/70">
          <div className="site-container grid items-center gap-8 py-7 md:grid-cols-2 md:gap-10 md:py-9">
            <img
              src={famImage}
              alt="The Fake Rider Motorparts riding family at a local motocross event"
              loading="lazy"
              width={773}
              height={768}
              // Beside the text, a 3:2 crop from the bottom trims only sky and trees, so
              // everyone in the photo stays whole.
              className="aspect-[773/768] h-auto w-full rounded-2xl border border-border/70 object-cover shadow-xl lg:aspect-[3/2] lg:object-bottom"
            />
            <div>
              <SectionHeading
                eyebrow="Our riders family"
                title="More than a shop, a riding community"
              />
              <p className="text-muted-foreground">
                From weekend trail rides to local motocross events, Fake Rider Motorparts grew with
                the riders it serves. Every bike that rolls into our garage gets the same care we
                give our own race bikes.
              </p>
              <p className="mt-4 text-muted-foreground">
                Commuter, long-distance rider or weekend racer, our crew explains the work in plain
                terms and helps you choose the right service or part.
              </p>
              <Button
                asChild
                variant="outline"
                className="mt-6 w-full font-display tracking-wide uppercase sm:w-auto"
              >
                <a href={SHOP.facebook} target="_blank" rel="noopener noreferrer">
                  <Facebook /> Follow us on Facebook
                </a>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}

function InfoTile({
  icon: Icon,
  title,
  value,
  href,
  external = false,
}: {
  icon: typeof MapPin;
  title: string;
  value: React.ReactNode;
  href?: string;
  external?: boolean;
}) {
  const content = (
    <>
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0">
        <p className="flex items-center gap-1 text-xs tracking-widest text-muted-foreground uppercase">
          {title}
          {external && <ExternalLink className="h-3 w-3" aria-hidden="true" />}
        </p>
        <p className="text-sm text-foreground">{value}</p>
      </div>
    </>
  );
  const className =
    "flex items-start gap-3 rounded-lg border border-border/70 bg-background/50 p-3 sm:p-4";

  if (href) {
    return (
      <a
        href={href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className={cn(
          className,
          "text-left transition-colors hover:border-primary/50 hover:bg-background/80",
        )}
      >
        {content}
      </a>
    );
  }

  return <div className={className}>{content}</div>;
}

export function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-5 md:mb-6">
      <p className="text-xs tracking-[0.3em] text-orange-700 uppercase dark:text-accent">
        {eyebrow}
      </p>
      <h2 className="font-display text-3xl font-bold uppercase md:text-4xl">{title}</h2>
      {description && <p className="mt-2 max-w-2xl text-muted-foreground">{description}</p>}
    </div>
  );
}

/** The "see more" link under a section: full width on phones, a button elsewhere. */
function SectionLink({ to, children }: { to: "/services" | "/shop"; children: string }) {
  return (
    <Button
      asChild
      variant="outline"
      className="mt-5 w-full font-display tracking-wide uppercase sm:w-auto"
    >
      <Link to={to}>
        {children} <ArrowRight />
      </Link>
    </Button>
  );
}
