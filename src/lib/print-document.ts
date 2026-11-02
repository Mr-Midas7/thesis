/**
 * Printing through the browser's print dialog ("Save as PDF" included). The
 * browser breaks the document into pages, so whatever paper size and margins
 * are chosen in the dialog, the content flows onto them without blank pages:
 * rows are never split, a section heading stays with its table, a table's
 * header row repeats on each page, and the signatures stay together after the
 * last table. By default the pages are A4 landscape without the browser's own
 * header and footer.
 * The printable markup is PrintDocument in components/admin/print-document.tsx.
 */
import { useEffect, useRef } from "react";

/** The report's own margins (millimetres), added to any set in the print dialog. */
const PRINT_MARGIN_MM = { top: 12, bottom: 15, side: 11 };
/** Space between the last table and the signatures. */
const SIGN_OFF_GAP_MM = 10;

/**
 * Keeps the signatures from starting a page on their own. Copies of them, and
 * of the final table's last row and total, go into one row group at the end
 * of that table, which the browser keeps on one page; when it moves to a new
 * page, the table's header row repeats above it. The originals are hidden.
 */
function keepSignOffWithLastRows(root: HTMLElement) {
  root.querySelector(".report-print-closing")?.remove();
  root.querySelectorAll(".report-print-moved").forEach((element) => {
    element.classList.remove("report-print-moved");
  });

  const signOff = root.querySelector<HTMLElement>(".report-print-signoff");
  const table =
    signOff?.previousElementSibling?.querySelector<HTMLTableElement>(".report-print-table");
  const body = table?.tBodies[0];
  if (!signOff || !table || !body) return;

  const closing = document.createElement("tbody");
  closing.className = "report-print-closing";
  const lastRow = body.rows[body.rows.length - 1];
  const rows = [...(lastRow ? [lastRow] : []), ...Array.from(table.tFoot?.rows ?? [])];
  for (const row of rows) {
    const copy = row.cloneNode(true) as HTMLTableRowElement;
    // Keep the look the row had where it was: a total, or a striped row.
    if (row.parentElement === table.tFoot) copy.classList.add("report-print-total");
    else if (row.sectionRowIndex % 2 === 1) copy.classList.add("report-print-striped");
    closing.append(copy);
    row.classList.add("report-print-moved");
  }
  const signOffCell = closing.insertRow().insertCell();
  signOffCell.parentElement?.classList.add("report-print-signoff-row");
  signOffCell.colSpan = table.tHead?.rows[0]?.cells.length ?? 1;
  signOffCell.append(signOff.cloneNode(true));
  signOff.classList.add("report-print-moved");
  table.append(closing);
}

export const PRINT_DOCUMENT_STYLES = `
  .report-print-root { display: none; }

  /*
   * A zero page margin stops the browser from printing its own header (page
   * title) and footer (URL, page numbers). The .report-print-page table puts
   * the margins back: its header and footer rows repeat on every page.
   */
  @page { size: A4 landscape; margin: 0; }

  @media print {
    html,
    body {
      width: auto !important;
      min-width: 0 !important;
      height: auto !important;
      margin: 0 !important;
      padding: 0 !important;
      background: #fff !important;
    }
    body > :not(.report-print-root) { display: none !important; }
    .report-print-root {
      position: static !important;
      display: block !important;
      width: auto !important;
      min-width: 0 !important;
      min-height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: visible !important;
      background: #fff;
    }
  }

  /* Layout and typography. */
  .report-print-page { width: 100%; border-collapse: collapse; border: 0; }
  .report-print-page > thead > tr > td { height: ${PRINT_MARGIN_MM.top}mm; padding: 0; border: 0; }
  .report-print-page > tfoot > tr > td { height: ${PRINT_MARGIN_MM.bottom}mm; padding: 0; border: 0; }
  .report-print-page > tbody > tr > td { padding: 0 ${PRINT_MARGIN_MM.side}mm; border: 0; vertical-align: top; }
  .report-print-document {
    width: 100%;
    min-width: 0;
    color: #1f2937;
    font-family: Arial, Helvetica, sans-serif;
  }

  .report-print-signoff { margin-top: ${SIGN_OFF_GAP_MM}mm; }
  /* See keepSignOffWithLastRows. */
  .report-print-moved { display: none !important; }
  .report-print-closing { break-inside: avoid-page; page-break-inside: avoid; }
  .report-print-header,
  .report-print-meta,
  .report-print-summary,
  .report-print-signoff {
    break-inside: avoid-page;
    page-break-inside: avoid;
  }
  .report-print-header {
    display: grid;
    /* The empty third column matches the logo's, so the title stays centred. */
    grid-template-columns: 26mm minmax(0, 1fr) 26mm;
    align-items: center;
    gap: 6mm;
  }
  .report-print-logo { display: block; width: 24mm; max-width: 100%; height: auto; aspect-ratio: 360 / 202; object-fit: contain; }
  .report-print-heading { min-width: 0; text-align: center; }
  .report-print-heading p { margin: 0; font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; }
  .report-print-heading p:nth-child(2) { margin-top: 1mm; font-size: 7pt; letter-spacing: .03em; text-transform: none; }
  .report-print-heading h1 { margin: 3mm 0 2mm; font-size: 18pt; font-weight: 700; letter-spacing: .04em; overflow-wrap: anywhere; text-transform: uppercase; }
  .report-print-heading p:last-child { font-size: 7pt; font-weight: 700; }
  .report-print-rule { height: 1.25pt; margin: 5mm 0 4mm; background: #0f5b49; }
  .report-print-meta { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8mm; font-size: 8pt; }
  .report-print-meta div:last-child { text-align: right; }
  .report-print-meta span,
  .report-print-summary span { display: block; color: #4b5563; font-size: 7pt; text-transform: uppercase; letter-spacing: .04em; }
  .report-print-meta strong { display: block; margin-top: 1mm; overflow-wrap: anywhere; font-size: 9pt; font-weight: 600; }
  .report-print-section { min-width: 0; margin-top: 6mm; break-inside: auto; page-break-inside: auto; }
  .report-print-section h2 { margin: 0 0 3mm; break-after: avoid-page; page-break-after: avoid; font-size: 11pt; font-weight: 700; }
  .report-print-summary-table { width: 100%; border-collapse: collapse; font-size: 8pt; }
  .report-print-summary-table th,
  .report-print-summary-table td { border: .75pt solid #6b7280; padding: 2.25mm 2mm; }
  .report-print-summary-table th { background: #e5e7eb; font-size: 7pt; text-align: left; text-transform: uppercase; }
  .report-print-summary-table th:last-child,
  .report-print-summary-table td:last-child { text-align: right; }
  .report-print-summary-table tbody tr:last-child td { font-weight: 700; background: #f3f4f6; }
  .report-print-table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 7.5pt; }
  .report-print-table thead { display: table-header-group; break-inside: avoid-page; background: #e5e7eb; }
  .report-print-table th,
  .report-print-table td { box-sizing: border-box; border: .75pt solid #6b7280; padding: 2.25mm 2mm; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
  .report-print-table th { font-size: 7pt; text-align: left; font-weight: 700; }
  .report-print-table th:last-child,
  .report-print-table td:last-child { text-align: right; }
  .report-print-table.report-print-text-end th:last-child,
  .report-print-table.report-print-text-end td:last-child { text-align: left; }
  .report-print-table tr { break-inside: avoid-page; page-break-inside: avoid; }
  .report-print-table tbody tr:nth-child(even) { background: #f9fafb; }
  .report-print-table tfoot { display: table-row-group; break-inside: avoid-page; font-weight: 700; background: #f3f4f6; }
  .report-print-table tfoot td:first-child { text-transform: uppercase; }
  .report-print-table tbody tr.report-print-striped { background: #f9fafb; }
  .report-print-table tbody tr.report-print-total { font-weight: 700; background: #f3f4f6; }
  .report-print-table tbody tr.report-print-total td:first-child { text-transform: uppercase; }
  .report-print-table tbody tr.report-print-signoff-row { background: #fff; }
  .report-print-table tbody tr.report-print-signoff-row > td { border: 0; padding: 0; text-align: left; }
  .report-print-footer { display: grid; grid-template-columns: 1fr 1fr; gap: 30mm; font-size: 8pt; }
  .report-print-footer > div:last-child { text-align: right; }
  .report-print-footer span,
  .report-print-footer small { display: block; color: #4b5563; }
  .report-print-footer strong { display: block; margin-top: 6mm; }
  .report-print-footer div > div { margin-top: 2mm; border-bottom: .75pt solid #374151; }
`;

/**
 * Prints the rendered PrintDocument: waits for the logo, keeps the signatures
 * with the last rows, names the print (the browser uses it as the "Save as
 * PDF" file name), opens the print dialog, then calls onDone. A null title
 * means nothing to print.
 */
export function usePrintWhenReady(documentTitle: string | null, onDone: () => void) {
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    if (!documentTitle) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const root = document.querySelector<HTMLElement>(".report-print-root");
      if (root) {
        // The logo must be decoded before printing, or it can print blank.
        await Promise.all(
          Array.from(root.querySelectorAll("img"), (image) =>
            image.decode().catch(() => undefined),
          ),
        );
        if (cancelled) return;
        keepSignOffWithLastRows(root);
      }
      const previousTitle = document.title;
      document.title = documentTitle;
      window.addEventListener("afterprint", () => (document.title = previousTitle), {
        once: true,
      });
      window.print();
      onDoneRef.current();
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [documentTitle]);
}
