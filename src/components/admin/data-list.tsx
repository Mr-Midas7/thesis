import {
  Archive,
  CircleAlert,
  EllipsisVertical,
  RotateCcw,
  Search,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { activeStatusTone } from "@/lib/shop";
import { cn } from "@/lib/utils";

/*
 * Shared building blocks for admin list pages, so every page has the same
 * width, toolbar, list card, and loading/error/empty states.
 *
 * Lists show one card per record below `lg` and a compact table from `lg` up.
 * The admin sidebar leaves too little room for a table on tablets, and cards
 * never need to scroll sideways.
 */

export function AdminPage({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("mx-auto w-full max-w-7xl", className)}>{children}</div>;
}

/** Search, filters, and a result summary above a list. */
export function ListToolbar({ children, summary }: { children: ReactNode; summary?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
      {children}
      {summary && <p className="text-sm text-muted-foreground lg:ml-auto">{summary}</p>}
    </div>
  );
}

export function ToolbarSearch({
  value,
  onChange,
  placeholder,
  label,
  id,
  onEnter,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** Accessible name, e.g. "Search mechanics by name". */
  label: string;
  id?: string;
  /** For toolbars with an explicit apply step. */
  onEnter?: () => void;
  className?: string;
}) {
  return (
    <div className={cn("relative min-w-0 lg:w-72", className)}>
      <Search
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        id={id}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={
          onEnter
            ? (event) => {
                if (event.key === "Enter") onEnter();
              }
            : undefined
        }
        placeholder={placeholder}
        aria-label={label}
        className="pl-9"
      />
    </div>
  );
}

/** Filter controls: two per row on phones, one line from `sm` up. */
export function ToolbarFilters({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-center">{children}</div>
  );
}

export function ResetFiltersButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="outline" onClick={onClick} className="col-span-2 sm:col-span-1">
      <RotateCcw /> Reset filters
    </Button>
  );
}

/** The card that holds a list, with an optional bar above it and footer below. */
export function ListCard({
  children,
  header,
  footer,
  className,
}: {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("overflow-hidden border-border/70 bg-card/60", className)}>
      {header && <div className="border-b border-border/70 px-4 py-3 sm:px-5">{header}</div>}
      <CardContent className="p-0">{children}</CardContent>
      {footer}
    </Card>
  );
}

/** A section title and description for the bar at the top of a ListCard. */
export function ListCardTitle({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h2 className="font-display text-base tracking-wide uppercase">{title}</h2>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export type DataListColumn<T> = {
  key: string;
  /** Table header, and the field label in the card layout. */
  header: string;
  cell: (row: T) => ReactNode;
  /**
   * Where the value goes on a card: "title" stacks at the top left, "badge" at
   * the top right, "field" in the labelled grid, and "wide" spans that grid.
   * `false` leaves it off the card (for example, when a title already shows it).
   */
  card?: "title" | "badge" | "field" | "wide" | false;
  /** Leave the column out of the table and show it on cards only. */
  table?: false;
  /** Show the table column from `xl` up only, where there is room for it. */
  xlOnly?: boolean;
  /** Width and alignment for the table column, e.g. "w-32 text-right". */
  className?: string;
};

export function DataList<T>({
  rows,
  columns,
  rowKey,
  label,
  actions,
  actionsClassName = "w-40",
  rowClassName,
  loading,
  error,
  empty,
  loadingRows = 5,
}: {
  rows: readonly T[];
  columns: DataListColumn<T>[];
  rowKey: (row: T) => string;
  /** Accessible name for the list, e.g. "Mechanics". */
  label: string;
  /** Row actions: the last table column and the end of each card. */
  actions?: (row: T) => ReactNode;
  /** Width of the table's actions column. */
  actionsClassName?: string;
  rowClassName?: (row: T) => string | undefined;
  loading?: boolean;
  error?: { message: string; onRetry?: () => void } | null;
  /** Shown when there are no rows and nothing is loading or failing. */
  empty?: ReactNode;
  loadingRows?: number;
}) {
  if (loading)
    return <ListLoading label={`Loading ${label.toLocaleLowerCase()}`} rows={loadingRows} />;
  if (error) return <ListError message={error.message} onRetry={error.onRetry} />;
  if (rows.length === 0) return <>{empty}</>;

  const titles = columns.filter((column) => column.card === "title");
  const badges = columns.filter((column) => column.card === "badge");
  const fields = columns.filter(
    (column) => column.card === undefined || column.card === "field" || column.card === "wide",
  );
  const tableColumns = columns.filter((column) => column.table !== false);
  const lastColumn = tableColumns.length - 1;

  return (
    <>
      <ul aria-label={label} className="divide-y divide-border/70 lg:hidden">
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            className={cn(
              "grid gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-x-6",
              rowClassName?.(row),
            )}
          >
            <div className="min-w-0 space-y-3">
              {(titles.length > 0 || badges.length > 0) && (
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-0.5 break-words">
                    {titles.map((column) => (
                      <div key={column.key}>{column.cell(row)}</div>
                    ))}
                  </div>
                  {badges.length > 0 && (
                    <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
                      {badges.map((column) => (
                        <span key={column.key}>{column.cell(row)}</span>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {fields.length > 0 && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm sm:grid-cols-3">
                  {fields.map((column) => (
                    <div
                      key={column.key}
                      className={cn(
                        "min-w-0",
                        column.card === "wide" && "col-span-2 sm:col-span-3",
                      )}
                    >
                      <dt className="text-[11px] tracking-wide text-muted-foreground uppercase">
                        {column.header}
                      </dt>
                      <dd className="mt-0.5 break-words">{column.cell(row)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            {actions && (
              <div className="flex flex-wrap items-center justify-end gap-2 sm:flex-col sm:items-end sm:justify-start">
                {actions(row)}
              </div>
            )}
          </li>
        ))}
      </ul>

      <Table aria-label={label} className="hidden w-full table-fixed lg:table">
        <TableHeader>
          <TableRow>
            {tableColumns.map((column, index) => (
              <TableHead
                key={column.key}
                className={cn(
                  index === 0 && "pl-5",
                  index === lastColumn && !actions && "pr-5",
                  column.xlOnly && "hidden xl:table-cell",
                  column.className,
                )}
              >
                {column.header}
              </TableHead>
            ))}
            {actions && (
              <TableHead className={cn("pr-5 text-right", actionsClassName)}>
                <span className="sr-only">Actions</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={rowKey(row)} className={cn("align-top", rowClassName?.(row))}>
              {tableColumns.map((column, index) => (
                <TableCell
                  key={column.key}
                  className={cn(
                    "py-3 break-words",
                    index === 0 && "pl-5",
                    index === lastColumn && !actions && "pr-5",
                    column.xlOnly && "hidden xl:table-cell",
                    column.className,
                  )}
                >
                  {column.cell(row)}
                </TableCell>
              ))}
              {actions && (
                <TableCell className="py-3 pr-5">
                  <div className="flex flex-wrap justify-end gap-2">{actions(row)}</div>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
}

export function ListLoading({ label, rows = 5 }: { label: string; rows?: number }) {
  return (
    <div className="divide-y divide-border/70" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="space-y-2 p-4">
          <Skeleton className="h-4 w-48 max-w-full" />
          <Skeleton className="h-3 w-72 max-w-full" />
        </div>
      ))}
    </div>
  );
}

export function ListError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="inline-flex items-center gap-2 text-sm text-destructive">
        <CircleAlert className="size-4 shrink-0" aria-hidden="true" /> {message}
      </p>
      {onRetry && (
        <div className="mt-3">
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  );
}

export function ListEmpty({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="px-4 py-12 text-center">
      <Icon className="mx-auto size-8 text-muted-foreground/60" aria-hidden="true" />
      <p className="mt-3 text-sm font-medium">{title}</p>
      {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * The "⋮" menu next to a row's main action, holding secondary actions such as
 * View details and Archive. Pass DropdownMenuItem elements as children.
 */
export function MoreActionsMenu({
  itemLabel,
  children,
}: {
  /** Names the record for screen readers, e.g. "More actions for Juan Cruz". */
  itemLabel: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={`More actions for ${itemLabel}`}
            >
              <EllipsisVertical className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>More actions</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The red Archive entry for a MoreActionsMenu. With `unavailableReason`, the
 * entry is disabled and says why.
 */
export function ArchiveMenuItem({
  onSelect,
  disabled,
  unavailableReason,
}: {
  onSelect: () => void;
  disabled?: boolean;
  unavailableReason?: string | undefined;
}) {
  if (unavailableReason) {
    return (
      <DropdownMenuItem disabled className="max-w-60 flex-col items-start gap-0.5">
        <span className="flex items-center gap-2">
          <Archive /> Archive
        </span>
        <span className="text-xs text-muted-foreground">{unavailableReason}</span>
      </DropdownMenuItem>
    );
  }
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      disabled={disabled ?? false}
      className="text-destructive focus:text-destructive"
    >
      <Archive /> Archive
    </DropdownMenuItem>
  );
}

/** A failed action or warning shown above a list. */
export function InlineAlert({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p
      role="alert"
      className={cn(
        "mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive",
        className,
      )}
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

export function ActiveStatusBadge({
  active,
  activeLabel = "Active",
  inactiveLabel = "Inactive",
}: {
  active: boolean;
  activeLabel?: string;
  inactiveLabel?: string;
}) {
  return (
    <Badge variant="outline" className={cn("uppercase", activeStatusTone(active))}>
      {active ? activeLabel : inactiveLabel}
    </Badge>
  );
}
