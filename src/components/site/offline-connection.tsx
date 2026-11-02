import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { Loader2, Wifi, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type OfflineStatus = {
  enabled: true;
  online: boolean;
  /** Offline bookings not yet sent to the live site. */
  waiting: number;
  liveSiteUrl: string | null;
};

/**
 * Offline copy only (src/lib/offline-sync.server.ts): shows whether the shop is
 * offline. Once the internet is back and every offline booking has been sent,
 * people move to the live site on their next page change, never in the middle
 * of a form. Shows nothing while sending to the live site is switched off.
 */
export function OfflineConnection() {
  const router = useRouter();
  const status = useQuery({
    queryKey: ["offline-status"],
    queryFn: async (): Promise<OfflineStatus | null> => {
      const response = await fetch("/api/offline-status", { cache: "no-store" });
      return response.ok ? ((await response.json()) as OfflineStatus) : null;
    },
    refetchInterval: 15_000,
    retry: false,
  });
  const data = status.data;
  const liveSiteUrl = data?.online && data.waiting === 0 ? data.liveSiteUrl : null;

  // The laptop can have internet while a phone on its hotspot does not, so each
  // browser checks for itself that it can open the live site.
  const [reachableUrl, setReachableUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!liveSiteUrl || reachableUrl === liveSiteUrl) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    fetch(liveSiteUrl, { mode: "no-cors", cache: "no-store", signal: controller.signal })
      .then(() => setReachableUrl(liveSiteUrl))
      .catch(() => setReachableUrl(null))
      .finally(() => clearTimeout(timer));
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [liveSiteUrl, reachableUrl, status.dataUpdatedAt]);

  const moveTo = liveSiteUrl && reachableUrl === liveSiteUrl ? liveSiteUrl : null;
  const moveToRef = useRef(moveTo);
  useEffect(() => {
    moveToRef.current = moveTo;
  }, [moveTo]);
  useEffect(
    () =>
      router.subscribe("onBeforeNavigate", ({ toLocation }) => {
        if (moveToRef.current) window.location.assign(`${moveToRef.current}${toLocation.href}`);
      }),
    [router],
  );

  if (!data?.enabled) return null;
  const plural = data.waiting === 1 ? "" : "s";
  const message = !data.online
    ? data.waiting
      ? `Offline mode: ${data.waiting} booking${plural} will be sent to the live site when the internet is back.`
      : "Offline mode: bookings are saved here and sent to the live site when the internet is back."
    : data.waiting
      ? `Internet is back. Sending ${data.waiting} offline booking${plural} to the live site…`
      : moveTo
        ? "Internet is back. The live site takes over from your next page."
        : "Internet is back. Offline bookings have been sent to the live site.";

  return (
    <div
      role="status"
      className="fixed right-3 bottom-3 z-50 flex max-w-[calc(100vw-1.5rem)] items-center gap-2 rounded-2xl border border-border/70 bg-card/95 px-3 py-2 text-xs text-foreground shadow-md backdrop-blur-sm sm:max-w-sm"
    >
      {!data.online ? (
        <WifiOff className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : data.waiting ? (
        <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
      ) : (
        <Wifi className="size-4 shrink-0 text-primary" aria-hidden="true" />
      )}
      <span>{message}</span>
      {moveTo && (
        <a
          href={`${moveTo}${router.state.location.href}`}
          className="shrink-0 font-medium text-primary underline underline-offset-2"
        >
          Go now
        </a>
      )}
    </div>
  );
}
