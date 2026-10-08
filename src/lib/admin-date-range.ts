import type { DateRange } from "react-day-picker";

import { addDays, manilaNow } from "@/lib/shop";

export type IsoDateRange = { from: string; to: string };

/**
 * Calendar selections are calendar days, not instants. Read their local date
 * fields directly so an administrator's browser timezone cannot shift a
 * selected day when it is sent to the database.
 */
export function calendarDateToIso(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Create a local-noon calendar value for an ISO date, safe for date pickers. */
export function isoDateToCalendarDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12);
}

export function normalizeIsoDateRange(from: string, to: string): IsoDateRange {
  return from <= to ? { from, to } : { from: to, to: from };
}

export function calendarRangeToIso(range: DateRange | undefined): IsoDateRange | undefined {
  if (!range?.from || !range.to) return undefined;
  return normalizeIsoDateRange(calendarDateToIso(range.from), calendarDateToIso(range.to));
}

export function manilaWeekDateRange(today = manilaNow().date): IsoDateRange {
  const date = isoDateToCalendarDate(today);
  const mondayOffset = (date.getDay() + 6) % 7;
  const from = addDays(today, -mondayOffset);
  return { from, to: addDays(from, 6) };
}

export function manilaMonthDateRange(today = manilaNow().date): IsoDateRange {
  const date = isoDateToCalendarDate(today);
  const from = `${today.slice(0, 7)}-01`;
  const to = calendarDateToIso(new Date(date.getFullYear(), date.getMonth() + 1, 0, 12));
  return { from, to };
}

export function manilaYearDateRange(today = manilaNow().date): IsoDateRange {
  const year = today.slice(0, 4);
  return { from: `${year}-01-01`, to: `${year}-12-31` };
}

/** Inclusive date filters on timestamptz columns use this exclusive upper bound. */
export function startOfNextManilaDay(date: string) {
  return `${addDays(date, 1)}T00:00:00+08:00`;
}

export function startOfManilaDay(date: string) {
  return `${date}T00:00:00+08:00`;
}
