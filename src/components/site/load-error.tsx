import { CircleAlert, RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A list that failed to load, with a button to load it again. The list shows
 * its loading placeholders again while it retries.
 */
export function LoadError({
  message,
  onRetry,
  className,
}: {
  message: string;
  onRetry: () => void;
  className?: string;
}) {
  return (
    <div role="alert" className={cn("flex flex-wrap items-center gap-3", className)}>
      <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
        <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden="true" /> {message}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        <RotateCw aria-hidden="true" /> Try again
      </Button>
    </div>
  );
}
