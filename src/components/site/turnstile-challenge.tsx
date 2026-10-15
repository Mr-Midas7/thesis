import { CircleAlert, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const TURNSTILE_SCRIPT_ID = "cloudflare-turnstile";
/** Cloudflare's full-width widget needs at least this much room; below it, the compact one is used. */
const TURNSTILE_MIN_WIDTH = 300;

type TurnstileTheme = "light" | "dark";

type TurnstileWidget = {
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: TurnstileTheme;
      size: "flexible" | "compact";
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
};

declare global {
  interface Window {
    turnstile?: TurnstileWidget;
  }
}

type TurnstileChallengeProps = {
  resetKey: string;
  onToken: (token: string) => void;
  /** What the check unlocks, shown above the widget. */
  label?: string;
};

type ChallengeStatus = "loading" | "shown" | "failed";

/** The site's own light/dark choice, which can differ from the device setting. */
function siteTheme(): TurnstileTheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/** Cloudflare's explicitly rendered widget, used only when a site key is configured. */
export function TurnstileChallenge({
  resetKey,
  onToken,
  label = "Complete the security check to submit your booking.",
}: TurnstileChallengeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ChallengeStatus>("loading");
  const enabled = Boolean(import.meta.env["VITE_TURNSTILE_SITE_KEY"]);

  useEffect(() => {
    const sitekey = import.meta.env["VITE_TURNSTILE_SITE_KEY"];
    const container = containerRef.current;
    if (!sitekey || !container) return;

    let active = true;
    let widgetId: string | undefined;
    let renderedTheme = siteTheme();
    // The booking review step is mounted while hidden. Waiting until the
    // container has a width lets the widget size fit the space it is shown in.
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => render());
    // The widget cannot change theme once shown, so it is recreated (and
    // verifies again) when the site switches between light and dark.
    const themeObserver = new MutationObserver(() => {
      if (!widgetId || !window.turnstile || siteTheme() === renderedTheme) return;
      window.turnstile.remove(widgetId);
      widgetId = undefined;
      onToken("");
      render();
    });

    // Runs once api.js has loaded. turnstile.ready() is only for pages that
    // load the script synchronously; Cloudflare warns when it is used here.
    function render() {
      if (!active || !container || widgetId || !window.turnstile) return;
      if (resizeObserver && container.clientWidth === 0) return;
      resizeObserver?.disconnect();
      renderedTheme = siteTheme();
      widgetId = window.turnstile.render(container, {
        sitekey,
        action: "booking",
        theme: renderedTheme,
        size: container.clientWidth < TURNSTILE_MIN_WIDTH ? "compact" : "flexible",
        callback: (token) => {
          setStatus("shown");
          onToken(token);
        },
        "expired-callback": () => onToken(""),
        "error-callback": () => {
          setStatus("failed");
          onToken("");
        },
      });
      setStatus("shown");
    }

    const scriptFailed = () => {
      if (active) setStatus("failed");
    };
    let script = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      document.head.append(script);
    }

    resizeObserver?.observe(container);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    if (window.turnstile) render();
    else {
      script.addEventListener("load", render);
      script.addEventListener("error", scriptFailed);
    }

    return () => {
      active = false;
      resizeObserver?.disconnect();
      themeObserver.disconnect();
      script?.removeEventListener("load", render);
      script?.removeEventListener("error", scriptFailed);
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
      setStatus("loading");
    };
  }, [onToken, resetKey]);

  if (!enabled) return null;

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{label}</p>
      {/* Space for the widget (65px tall when full width) so the page does not
          jump; not kept when the widget could not load at all. */}
      <div className={cn("relative w-full sm:max-w-sm", status !== "failed" && "min-h-[65px]")}>
        {status === "loading" && (
          <div
            className="absolute inset-0 flex items-center gap-2 rounded-md border border-dashed border-border px-3 text-sm text-muted-foreground"
            aria-live="polite"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading security check…
          </div>
        )}
        <div ref={containerRef} className="w-full" />
      </div>
      {status === "failed" && (
        <p role="alert" className="flex items-start gap-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          The security check couldn’t load. Check your internet connection or turn off ad blockers
          for this site, then reload the page.
        </p>
      )}
    </div>
  );
}
