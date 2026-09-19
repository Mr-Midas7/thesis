import { useEffect, useRef } from "react";

const TURNSTILE_SCRIPT_ID = "cloudflare-turnstile";

type TurnstileWidget = {
  ready: (callback: () => void) => void;
  render: (
    container: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      theme: "auto";
      size: "flexible";
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
};

/** Cloudflare's explicitly rendered widget, used only when a site key is configured. */
export function TurnstileChallenge({ resetKey, onToken }: TurnstileChallengeProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const enabled = Boolean(import.meta.env["VITE_TURNSTILE_SITE_KEY"]);

  useEffect(() => {
    const sitekey = import.meta.env["VITE_TURNSTILE_SITE_KEY"];
    const container = containerRef.current;
    if (!sitekey || !container) return;

    let active = true;
    let widgetId: string | undefined;

    const render = () => {
      if (!active || !container || widgetId || !window.turnstile) return;
      window.turnstile.ready(() => {
        if (!active || widgetId || !window.turnstile) return;
        widgetId = window.turnstile.render(container, {
          sitekey,
          action: "booking",
          theme: "auto",
          size: "flexible",
          callback: onToken,
          "expired-callback": () => onToken(""),
          "error-callback": () => onToken(""),
        });
      });
    };

    let script = document.getElementById(TURNSTILE_SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement("script");
      script.id = TURNSTILE_SCRIPT_ID;
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      document.head.append(script);
    }

    if (window.turnstile) render();
    else script.addEventListener("load", render);

    return () => {
      active = false;
      script?.removeEventListener("load", render);
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [onToken, resetKey]);

  if (!enabled) return null;

  return (
    <div className="mt-4 space-y-2">
      <p className="text-sm text-muted-foreground">
        Complete the security check to confirm booking.
      </p>
      <div ref={containerRef} className="w-full" />
    </div>
  );
}
