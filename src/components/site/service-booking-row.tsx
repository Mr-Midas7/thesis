import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatPHP } from "@/lib/shop";

/**
 * The bottom of a service card on the homepage and the Services page: the
 * lowest price (small-bike rate, or the large-bike rate if lower) and a Book
 * button that opens booking with this service already selected.
 */
export function ServiceBookingRow({
  service,
}: {
  service: { id: string; name: string; price: number; large_bike_price: number | null };
}) {
  const price = Math.min(service.price, service.large_bike_price ?? service.price);
  return (
    <div className="mt-auto flex items-end justify-between gap-3 pt-4">
      {/* A service without a set price is priced after the shop sees the bike. */}
      {price > 0 ? (
        <p className="text-sm text-muted-foreground">
          <span className="block text-xs uppercase">From</span>
          <span className="font-display text-xl font-bold text-primary">{formatPHP(price)}</span>
        </p>
      ) : (
        <p className="text-sm font-medium text-muted-foreground">Quoted at the shop</p>
      )}
      <Button asChild size="sm" variant="outline" className="font-display tracking-wide uppercase">
        <Link to="/book" search={{ serviceId: service.id }} aria-label={`Book ${service.name}`}>
          Book <ArrowRight />
        </Link>
      </Button>
    </div>
  );
}
