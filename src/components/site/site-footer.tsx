import { Link } from "@tanstack/react-router";
import { Clock, Facebook, Mail, MapPin, Phone } from "lucide-react";

import { SHOP } from "@/lib/shop";
import { cn } from "@/lib/utils";

const GOOGLE_MAPS_URL =
  "https://www.google.com/maps/search/?api=1&query=9.628199644198734,123.88388780871496";

export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer className={cn("mt-20 border-t border-border/70 bg-card/40", className)}>
      <div className="site-container grid gap-10 py-12 md:grid-cols-3">
        <div>
          <a
            href={GOOGLE_MAPS_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="Open Fake Rider Motorparts location in Google Maps"
            className="group relative block overflow-hidden rounded-xl border border-border/70 bg-muted/30 transition-colors hover:border-primary/60"
          >
            <iframe
              title="Fake Rider Motorparts location"
              src="https://www.google.com/maps/embed?pb=!1m14!1m12!1m3!1d3933.6170930116095!2d123.88388780871496!3d9.628199644198734!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!5e0!3m2!1sen!2sph!4v1788968991394!5m2!1sen!2sph"
              loading="lazy"
              referrerPolicy="strict-origin-when-cross-origin"
              className="pointer-events-none block h-40 w-full border-0"
            />
            <span className="absolute inset-x-0 bottom-0 flex items-center gap-2 bg-background/85 px-3 py-2 text-xs font-medium text-foreground backdrop-blur-sm">
              <MapPin className="h-3.5 w-3.5 text-primary" /> Open in Google Maps
            </span>
          </a>
          <p className="mt-3 max-w-xs text-sm text-muted-foreground">
            Your local pit stop for premium motorparts, accessories and race-grade service. Ride
            hard, maintain harder.
          </p>
        </div>
        <div className="space-y-2 text-sm text-muted-foreground">
          <h3 className="font-display text-base tracking-wide text-foreground uppercase">
            Visit the Shop
          </h3>
          <p className="flex items-start gap-2">
            <MapPin className="mt-0.5 h-4 w-4 text-primary" /> {SHOP.address}
          </p>
          <p className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-primary" /> {SHOP.hours}
          </p>
          <p className="flex items-center gap-2">
            <Phone className="h-4 w-4 text-primary" /> {SHOP.phone}
          </p>
          <p className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-primary" /> {SHOP.email}
          </p>
          <p className="flex items-center gap-2">
            <Facebook className="h-4 w-4 text-primary" />
            <a
              href={SHOP.facebook}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
            >
              Fake Rider Motorparts
            </a>
          </p>
        </div>
        <div className="space-y-2 text-sm">
          <h3 className="font-display text-base tracking-wide text-foreground uppercase">
            Quick Links
          </h3>
          <div className="flex flex-col gap-2 text-muted-foreground">
            <Link to="/book" className="hover:text-foreground">
              Book an appointment
            </Link>
            <Link to="/my-appointment" className="hover:text-foreground">
              View or cancel a booking
            </Link>
            <Link to="/services" className="hover:text-foreground">
              Services & prices
            </Link>
            <Link to="/shop" className="hover:text-foreground">
              Parts & Accessories
            </Link>
          </div>
        </div>
      </div>
      <div className="border-t border-border/70 py-4 text-center text-xs text-muted-foreground">
        &copy; {new Date().getFullYear()} {SHOP.name}. All rights reserved.
      </div>
    </footer>
  );
}
