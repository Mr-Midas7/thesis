import { ImageIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatPHP, SHOP } from "@/lib/shop";
import { cn } from "@/lib/utils";

export type ProductRow = {
  id: string;
  name: string;
  category: string;
  brand: string | null;
  description: string | null;
  price: number | string;
  image_url: string | null;
  in_stock: boolean;
  is_featured: boolean;
};

/**
 * Opens the shop's Messenger chat with a message naming the item already typed
 * in; the customer still presses Send.
 */
function messengerReserveLink(product: ProductRow) {
  const item = [product.brand, product.name].filter(Boolean).join(" ");
  const message = `Hi! I would like to reserve ${item} (${formatPHP(product.price)}). Is it still available?`;
  return `${SHOP.messenger}?text=${encodeURIComponent(message)}`;
}

/** compact: a smaller card for two-per-row grids on phones; unchanged from sm up. */
export function ProductCard({
  product,
  compact = false,
}: {
  product: ProductRow;
  compact?: boolean;
}) {
  return (
    <Card className="group flex h-full flex-col overflow-hidden border-border/70 bg-card/70 py-0 transition-colors hover:border-primary/60 lg:min-w-0">
      {/* The whole product is shown on white, the way most product photos are shot. */}
      <div
        className={cn(
          "relative flex items-center justify-center overflow-hidden bg-white",
          compact ? "h-32 sm:h-44" : "h-44",
        )}
      >
        {product.image_url ? (
          <img
            src={product.image_url}
            alt={product.name}
            loading="lazy"
            className="h-full w-full object-contain p-3 transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <ImageIcon className="h-12 w-12 text-muted-foreground/50" />
        )}
        {product.is_featured && (
          <Badge className="absolute top-2 left-2 bg-primary text-primary-foreground uppercase">
            Featured
          </Badge>
        )}
        {!product.in_stock && (
          <Badge variant="outline" className="absolute top-2 right-2 bg-background/90 uppercase">
            Out of stock
          </Badge>
        )}
      </div>
      <CardContent
        className={cn("flex flex-1 flex-col", compact ? "p-3 sm:p-4 sm:pb-5" : "p-4 pb-5")}
      >
        <p className="truncate text-xs tracking-widest text-orange-700 uppercase dark:text-accent">
          {product.brand ?? product.category}
        </p>
        <div
          className={cn(
            "mt-1 flex items-start justify-between gap-3",
            compact && "max-sm:flex-col max-sm:gap-1",
          )}
        >
          <h3
            className={cn(
              "min-w-0 flex-1 font-display leading-tight tracking-wide uppercase lg:break-words",
              compact ? "text-base sm:text-lg" : "text-lg",
            )}
          >
            {product.name}
          </h3>
          <p className="shrink-0 font-display text-xl leading-tight font-bold tracking-wide text-primary">
            {formatPHP(product.price)}
          </p>
        </div>
        {product.description && (
          <p
            className={cn(
              "mt-2 line-clamp-2 text-sm text-muted-foreground lg:break-words",
              compact && "max-sm:hidden",
            )}
          >
            {product.description}
          </p>
        )}
        {product.in_stock ? (
          <div className={cn("mt-auto", compact ? "pt-3 sm:pt-4" : "pt-4")}>
            <Button asChild variant="outline" size="sm" className="w-full uppercase">
              <a
                href={messengerReserveLink(product)}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Reserve ${product.name} via Messenger`}
              >
                {compact ? (
                  <>
                    <span className="sm:hidden">Reserve</span>
                    <span className="max-sm:hidden">Reserve via Messenger</span>
                  </>
                ) : (
                  "Reserve via Messenger"
                )}
              </a>
            </Button>
          </div>
        ) : (
          <div className="mt-auto pt-4">
            <p className="text-xs text-muted-foreground">
              Message us to check future availability.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
