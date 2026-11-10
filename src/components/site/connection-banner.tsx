import { Wifi, WifiOff } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

const BACK_ONLINE_MS = 4_000;

/**
 * Tells people when their device loses its internet connection, and briefly
 * when it comes back. While offline, page data waits for the connection and
 * form submissions fail straight away with their own error message.
 */
export function ConnectionBanner() {
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  const [backOnline, setBackOnline] = useState(false);

  useEffect(() => {
    let timer: number | undefined;
    const showBackOnline = () => {
      window.clearTimeout(timer);
      setBackOnline(true);
      timer = window.setTimeout(() => setBackOnline(false), BACK_ONLINE_MS);
    };
    window.addEventListener("online", showBackOnline);
    return () => {
      window.removeEventListener("online", showBackOnline);
      window.clearTimeout(timer);
    };
  }, []);

  if (online && !backOnline) return null;

  return (
    <div
      role="status"
      className="fixed right-3 bottom-3 z-50 flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-2xl border border-border/70 bg-card/95 px-3 py-2 text-xs text-foreground shadow-md backdrop-blur-sm sm:max-w-sm"
    >
      {online ? (
        <Wifi className="size-4 shrink-0 text-primary" aria-hidden="true" />
      ) : (
        <WifiOff className="size-4 shrink-0 text-destructive" aria-hidden="true" />
      )}
      <span>
        {online
          ? "You're back online."
          : "You're offline. Check your internet connection. Nothing can be loaded or sent until you're back online."}
      </span>
    </div>
  );
}
