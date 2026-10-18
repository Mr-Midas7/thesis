export const SHOP_EXPORT_NAME = "FAKE RIDER MOTORPARTS";
export const SHOP_OWNER_NAME = "JOEMAR TATO";

export function formatBusinessTimestamp() {
  return new Date().toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
