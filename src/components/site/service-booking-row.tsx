import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The bottom of a service card on the homepage and the Services page: a Book
 * button that opens booking with this service already selected. Prices are not
 * shown here because they depend on the motorcycle; the booking form shows the
 * right price once the motorcycle is chosen.
 */
export function ServiceBookingRow({ service }: { service: { id: string; name: string } }) {
  return (
    <div className="mt-auto flex justify-end pt-4">
      <Button asChild size="sm" variant="outline" className="font-display tracking-wide uppercase">
        <Link to="/book" search={{ serviceId: service.id }} aria-label={`Book ${service.name}`}>
          Book <ArrowRight />
        </Link>
      </Button>
    </div>
  );
}
