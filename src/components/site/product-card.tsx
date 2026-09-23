import { ImageIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatPHP, SHOP } from "@/lib/shop";

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

export function ProductCard({ product }: { product: ProductRow }) {
  return (
    <Card className="group flex h-full flex-col overflow-hidden border-border/70 bg-card/70 py-0 transition-colors hover:border-primary/60">
      <div className="relative flex h-44 items-center justify-center overflow-hidden bg-secondary/50">
        {product.image_url ? (
          <img
            src={product.image_url}
            alt={product.name}
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
        ) : (
          <ImageIcon className="h-12 w-12 text-muted-foreground/50" />
        )}
        {product.is_featured && (
          <Badge className="absolute top-2 left-2 bg-primary text-primary-foreground uppercase">
            Featured
          </Badge>
        )}
        <Badge variant="outline" className="absolute top-2 right-2 bg-background/80 uppercase">
          {product.in_stock ? "In stock" : "Out of stock"}
        </Badge>
      </div>
      <CardContent className="flex flex-1 flex-col p-4 pb-5">
        <p className="text-xs tracking-widest text-accent uppercase">
          {product.brand ?? product.category}
        </p>
        <div className="mt-1 flex items-start justify-between gap-3">
          <h3 className="min-w-0 flex-1 font-display text-lg leading-tight tracking-wide uppercase">
            {product.name}
          </h3>
          <p className="shrink-0 font-display text-xl leading-tight font-bold tracking-wide text-primary">
            {formatPHP(product.price)}
          </p>
        </div>
        {product.description && (
          <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{product.description}</p>
        )}
        {product.in_stock ? (
          <div className="mt-auto pt-4">
            <Button asChild variant="outline" size="sm" className="w-full uppercase">
              <a href={SHOP.messenger} target="_blank" rel="noopener noreferrer">
                Reserve via Messenger
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
