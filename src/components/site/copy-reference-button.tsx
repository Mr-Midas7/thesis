import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Copies a booking reference code and briefly confirms the copy. */
export function CopyReferenceButton({
  value,
  className,
  size = "sm",
}: {
  value: string;
  className?: string;
  size?: "sm" | "default";
}) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    if (status !== "copied") return;
    const timer = window.setTimeout(() => setStatus("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [status]);

  return (
    <span className={cn("inline-flex flex-col items-center gap-1.5", className)}>
      <Button
        type="button"
        variant="outline"
        size={size}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setStatus("copied");
          } catch {
            setStatus("error");
          }
        }}
      >
        {status === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        {status === "copied" ? "Copied" : "Copy code"}
      </Button>
      <span className="sr-only" aria-live="polite">
        {status === "copied" ? "Reference code copied." : ""}
      </span>
      {status === "error" && (
        <span className="text-xs text-destructive" role="alert">
          Could not copy the code automatically. Please copy it manually.
        </span>
      )}
    </span>
  );
}
