import { format, parseISO } from "date-fns";

import { Calendar } from "@/components/ui/calendar";
import type { ComputedSlot } from "@/lib/availability";
import { formatTime, timeToMinutes } from "@/lib/shop";
import { cn } from "@/lib/utils";

/**
 * Calendar shared by the booking and reschedule flows. Only dates in
 * `availableDates` can be chosen; fully booked dates are struck through.
 */
export function BookingCalendar({
  selected,
  availableDates,
  fullyBookedDates,
  onSelect,
  className,
}: {
  selected: string;
  availableDates: Set<string>;
  fullyBookedDates: string[];
  onSelect: (date: string) => void;
  className?: string;
}) {
  const sortedDates = Array.from(availableDates).sort();
  const firstDate = sortedDates[0];
  const lastDate = sortedDates.at(-1);
  const initialMonth = selected || firstDate;

  return (
    <Calendar
      mode="single"
      selected={selected ? parseISO(selected) : undefined}
      onSelect={(day) => {
        if (!day) return;
        const iso = format(day, "yyyy-MM-dd");
        if (!availableDates.has(iso)) return;
        onSelect(iso);
      }}
      // Open on the month that has the first bookable date and keep navigation
      // within the months that actually contain available dates.
      {...(initialMonth ? { defaultMonth: parseISO(initialMonth) } : {})}
      {...(firstDate ? { startMonth: parseISO(firstDate) } : {})}
      {...(lastDate ? { endMonth: parseISO(lastDate) } : {})}
      disabled={(day) => !availableDates.has(format(day, "yyyy-MM-dd"))}
      modifiers={{ fullyBooked: fullyBookedDates.map((value) => parseISO(value)) }}
      modifiersClassNames={{
        fullyBooked: "bg-destructive/15 text-destructive line-through opacity-100",
      }}
      className={cn("p-0 min-[360px]:p-3", className)}
      classNames={{
        nav: "justify-between gap-1",
        month_caption: "flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
      }}
    />
  );
}

export function FullyBookedLegend({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
      <span
        aria-hidden="true"
        className="h-3 w-3 rounded-sm bg-destructive/15 ring-1 ring-destructive/40"
      />
      Fully booked dates cannot be selected.
    </p>
  );
}

const SLOT_GROUPS = [
  { label: "Morning", from: 0, to: 12 * 60 },
  { label: "Afternoon", from: 12 * 60, to: 17 * 60 },
  { label: "Evening", from: 17 * 60, to: 24 * 60 },
] as const;

/** Available start times for one date, grouped by part of the day. */
export function TimeSlotPicker({
  slots,
  value,
  onChange,
  invalid,
  className,
  gridClassName,
}: {
  slots: ComputedSlot[];
  value: string;
  onChange: (startTime: string) => void;
  invalid?: boolean;
  className?: string;
  gridClassName?: string;
}) {
  const available = slots.filter((slot) => !slot.disabled);

  if (available.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
        No times remain available for this date. Please choose another date.
      </p>
    );
  }

  const groups = SLOT_GROUPS.map((group) => ({
    label: group.label,
    slots: available.filter((slot) => {
      const minutes = timeToMinutes(slot.startTime);
      return minutes >= group.from && minutes < group.to;
    }),
  })).filter((group) => group.slots.length > 0);

  return (
    <div
      className={cn("space-y-4", invalid && "rounded-lg p-2 ring-1 ring-destructive", className)}
    >
      {groups.map((group) => (
        <div key={group.label}>
          <p className="mb-2 text-xs font-medium tracking-widest text-muted-foreground uppercase">
            {group.label}
          </p>
          <div className={cn("grid grid-cols-2 gap-2 sm:grid-cols-3", gridClassName)}>
            {group.slots.map((slot) => {
              const selected = value === slot.startTime;
              return (
                <button
                  type="button"
                  key={slot.id}
                  aria-pressed={selected}
                  onClick={() => onChange(slot.startTime)}
                  className={cn(
                    "h-11 rounded-lg border px-3 font-display text-base tracking-wide transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                    selected
                      ? "border-primary bg-primary text-primary-foreground shadow-sm"
                      : "border-border bg-background/60 hover:border-primary/60 hover:bg-primary/5",
                  )}
                >
                  {formatTime(slot.startTime)}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
