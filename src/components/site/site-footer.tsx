import { Link } from "@tanstack/react-router";
import { Clock, Facebook, Mail, MapPin, MessageCircle, Phone } from "lucide-react";
import type { ReactNode } from "react";

import { SHOP } from "@/lib/shop";
import { cn } from "@/lib/utils";

const QUICK_LINKS = [
  { to: "/book", label: "Book an appointment" },
  { to: "/my-appointment", label: "View or cancel a booking" },
  { to: "/services", label: "Services & prices" },
  { to: "/shop", label: "Parts & Accessories" },
] as const;

/** "Monday to Saturday, 8:00 AM – 5:00 PM", with the times kept on one line. */
export function ShopHours() {
  return (
    <>
      {SHOP.openDays}, <span className="whitespace-nowrap">{SHOP.openTimes}</span>
    </>
  );
}

export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer className={cn("border-t border-border/70 bg-card/40", className)}>
      <div className="site-container grid gap-7 py-8 md:grid-cols-3 md:gap-10 md:py-12">
        {/* On phones the contact details come first, then a small map beside the description. */}
        <div className="order-last flex items-center gap-4 md:order-none md:block">
          <a
            href={SHOP.mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open Fake Rider Motorparts location in Google Maps"
            className="group relative block w-40 shrink-0 overflow-hidden rounded-xl border border-border/70 bg-muted/30 transition-colors hover:border-primary/60 md:w-auto"
          >
            <iframe
              title="Map showing the Fake Rider Motorparts location"
              src={SHOP.mapEmbedUrl}
              loading="lazy"
              tabIndex={-1}
              referrerPolicy="strict-origin-when-cross-origin"
              className="pointer-events-none block h-28 w-full border-0 md:h-40"
            />
            <span className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-background/85 px-2.5 py-1.5 text-xs font-medium text-foreground backdrop-blur-sm md:gap-2 md:px-3 md:py-2">
              <MapPin className="h-3.5 w-3.5 text-primary" aria-hidden="true" /> Open in Google Maps
            </span>
          </a>
          <p className="max-w-xs text-sm text-muted-foreground md:mt-3">
            Motorcycle service, parts and accessories in Baclayon, Bohol. Book online or drop by
            during shop hours.
          </p>
        </div>

        <div className="text-sm text-muted-foreground">
          <h3 className="font-display text-base tracking-wide text-foreground uppercase">
            Visit the Shop
          </h3>
          <ul className="mt-2">
            <FooterItem icon={MapPin} href={SHOP.mapsUrl} external>
              {SHOP.address}
            </FooterItem>
            <FooterItem icon={Clock}>
              <ShopHours />
            </FooterItem>
            <FooterItem icon={Phone} href={`tel:${SHOP.phone.replace(/\s/g, "")}`}>
              {SHOP.phone}
            </FooterItem>
            <FooterItem icon={Mail} href={`mailto:${SHOP.email}`}>
              {SHOP.email}
            </FooterItem>
            <FooterItem icon={MessageCircle} href={SHOP.messenger} external>
              Message us on Messenger
            </FooterItem>
            <FooterItem icon={Facebook} href={SHOP.facebook} external>
              Facebook page
            </FooterItem>
          </ul>
        </div>

        <div className="text-sm">
          <h3 className="font-display text-base tracking-wide text-foreground uppercase">
            Quick Links
          </h3>
          {/* Two per row on phones keeps the footer short. */}
          <ul className="mt-2 grid grid-cols-2 gap-x-4 text-muted-foreground md:grid-cols-1">
            {QUICK_LINKS.map((link) => (
              <li key={link.to}>
                <Link to={link.to} className="block py-1.5 hover:text-foreground">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="border-t border-border/70 py-4 text-center text-xs text-muted-foreground">
        &copy; {new Date().getFullYear()} {SHOP.name}. All rights reserved.
      </div>
    </footer>
  );
}

/** A contact line; a link when href is given, with a tap area of about 32px. */
function FooterItem({
  icon: Icon,
  href,
  external = false,
  children,
}: {
  icon: typeof MapPin;
  href?: string;
  external?: boolean;
  children: ReactNode;
}) {
  const content = (
    <>
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 break-words">{children}</span>
    </>
  );
  return (
    <li>
      {href ? (
        <a
          href={href}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          className="flex items-start gap-2 py-1.5 hover:text-foreground"
        >
          {content}
        </a>
      ) : (
        <div className="flex items-start gap-2 py-1.5">{content}</div>
      )}
    </li>
  );
}
