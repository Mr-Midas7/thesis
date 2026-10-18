// An unfinished booking form, kept in this browser tab so a customer who looks
// at another page can come back to it. sessionStorage is cleared when the tab
// closes, and a draft is dropped 10 minutes after its last change.

const DRAFT_KEY = "fake-rider-booking-draft";
export const BOOKING_DRAFT_LIFETIME_MINUTES = 10;

export function loadBookingDraft<T>(parse: (value: unknown) => T | null): T | null {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { savedAt?: unknown; draft?: unknown };
    const age = Date.now() - Number(saved.savedAt);
    if (!(age >= 0 && age <= BOOKING_DRAFT_LIFETIME_MINUTES * 60_000)) {
      sessionStorage.removeItem(DRAFT_KEY);
      return null;
    }
    return parse(saved.draft);
  } catch {
    return null;
  }
}

export function saveBookingDraft(draft: unknown) {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), draft }));
  } catch {
    // Storage can be full or blocked; the form still works without a draft.
  }
}

export function clearBookingDraft() {
  try {
    sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to clear when storage is blocked.
  }
}
