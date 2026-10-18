/**
 * Printing through the browser's print dialog ("Save as PDF" included): A4
 * landscape pages without the browser's own header and footer, laid out here
 * so tables break cleanly and the sign-off sits at the bottom of the last page.
 * The printable markup is PrintDocument in components/admin/print-document.tsx.
 */
import { useEffect, useRef } from "react";

/** A4 landscape, and the margins on every printed page (millimetres). */
const PRINT_PAGE_MM = { width: 297, height: 210, top: 12, bottom: 15, side: 11 };
/** Sheets are a little shorter than the paper so rounding never spills onto an extra page. */
const PRINT_SHEET_HEIGHT_MM = PRINT_PAGE_MM.height - 1;
/** Content is never filled to the very edge of a sheet. */
const PRINT_SHEET_SAFETY_MM = 2;
const MM_TO_PX = 96 / 25.4;
/** Minimum space between the last table and the signatures. */
const SIGN_OFF_GAP_MM = 10;

/** The part of a table that is on one sheet. */
type PrintTablePart = {
  section: HTMLElement;
  table: HTMLElement;
  body: HTMLTableSectionElement;
  footer: HTMLElement | null;
  rows: number;
};

/**
 * Lays a printable document out on fixed A4 sheets, one per printed page, so the page
 * breaks are decided here rather than guessed. Rows and blocks are never split,
 * a section heading stays with its table, and a table's header row repeats on
 * each sheet it continues on. The signatures go at the bottom of the last sheet.
 * When there is not enough room below the content, they go on a new sheet,
 * together with the last row and total of the final table.
 *
 * Fills .report-print-sheets; if anything fails, the sheets stay empty and the
 * document prints as one flowing page instead.
 */
export function paginatePrintDocument(root: HTMLElement) {
  const sheets = root.querySelector<HTMLElement>(".report-print-sheets");
  const content = root.querySelector<HTMLElement>(".report-print-flow .report-print-content");
  const signOff = root.querySelector<HTMLElement>(".report-print-flow .report-print-signoff");
  if (!sheets || !content || !signOff) return;
  sheets.replaceChildren();

  const pageWidth = (PRINT_PAGE_MM.width - 2 * PRINT_PAGE_MM.side) * MM_TO_PX;
  const pageHeight =
    (PRINT_SHEET_HEIGHT_MM - PRINT_PAGE_MM.top - PRINT_PAGE_MM.bottom - PRINT_SHEET_SAFETY_MM) *
    MM_TO_PX;

  // Measure everything once at the printed width, off screen.
  const probe = document.createElement("article");
  probe.className = "report-print-document";
  Object.assign(probe.style, {
    position: "absolute",
    top: "0",
    left: "-100000px",
    width: `${pageWidth}px`,
    visibility: "hidden",
  });
  const flow = content.cloneNode(true) as HTMLElement;
  const signatures = signOff.cloneNode(true) as HTMLElement;
  probe.append(flow, signatures);
  document.body.append(probe);

  try {
    const height = (element: Element) => element.getBoundingClientRect().height;
    const margin = (element: Element, side: "marginTop" | "marginBottom") =>
      parseFloat(getComputedStyle(element)[side]) || 0;

    let sheet = document.createElement("section");
    let used = 0;
    const newSheet = () => {
      sheet = document.createElement("section");
      sheet.className = "report-print-document report-print-sheet";
      sheets.append(sheet);
      used = 0;
    };
    const fits = (extra: number) => used + extra <= pageHeight;
    newSheet();
    // The part of the final table on the current sheet, if the document ends in one.
    let lastTable: { part: PrintTablePart; continueOnNewSheet: () => PrintTablePart } | null = null;

    for (const block of Array.from(flow.children)) {
      const table = block.querySelector(".report-print-table");
      const rows = table
        ? [
            ...Array.from(table.querySelectorAll(":scope > tbody > tr"), (row) => ({
              row,
              inFooter: false,
            })),
            ...Array.from(table.querySelectorAll(":scope > tfoot > tr"), (row) => ({
              row,
              inFooter: true,
            })),
          ]
        : [];
      const firstRow = rows[0];
      const marginTop = margin(block, "marginTop");

      if (!table || !firstRow) {
        const blockHeight = height(block) + margin(block, "marginBottom");
        if (used > 0 && !fits(marginTop + blockHeight)) newSheet();
        const clone = block.cloneNode(true) as HTMLElement;
        // Space above a block is dropped at the top of a sheet.
        if (used === 0) clone.style.marginTop = "0";
        sheet.append(clone);
        used += (used === 0 ? 0 : marginTop) + blockHeight;
        lastTable = null;
        continue;
      }

      const heading = block.querySelector(":scope > h2");
      const colgroup = table.querySelector(":scope > colgroup");
      const thead = table.querySelector(":scope > thead");
      const headingHeight = heading
        ? height(heading) + margin(heading, "marginTop") + margin(heading, "marginBottom")
        : 0;
      const headerHeight = thead ? height(thead) : 0;

      // The part of this section on one sheet: the heading on the first sheet
      // only, and the table's column widths and header row on every sheet.
      const startPart = (withHeading: boolean) => {
        const section = block.cloneNode(false) as HTMLElement;
        if (used === 0) section.style.marginTop = "0";
        if (withHeading && heading) section.append(heading.cloneNode(true));
        const shell = table.cloneNode(false) as HTMLElement;
        if (colgroup) shell.append(colgroup.cloneNode(true));
        if (thead) shell.append(thead.cloneNode(true));
        const body = shell.appendChild(document.createElement("tbody"));
        section.append(shell);
        sheet.append(section);
        return { section, table: shell, body, footer: null as HTMLElement | null, rows: 0 };
      };

      // The heading, header row, and first row stay together.
      if (used > 0 && !fits(marginTop + headingHeight + headerHeight + height(firstRow.row))) {
        newSheet();
      }
      const sectionStart = (used === 0 ? 0 : marginTop) + headingHeight + headerHeight;
      let part = startPart(true);
      used += sectionStart;

      for (const { row, inFooter } of rows) {
        const rowHeight = height(row);
        if (part.rows > 0 && !fits(rowHeight)) {
          newSheet();
          part = startPart(false);
          used += headerHeight;
        }
        if (inFooter) {
          part.footer ??= part.table.appendChild(document.createElement("tfoot"));
          part.footer.append(row.cloneNode(true));
        } else {
          part.body.append(row.cloneNode(true));
        }
        part.rows += 1;
        used += rowHeight;
      }
      lastTable = { part, continueOnNewSheet: () => startPart(false) };
    }

    if (!fits(SIGN_OFF_GAP_MM * MM_TO_PX + height(signatures))) {
      newSheet();
      // The signatures never sit alone on a page: the final table's last row
      // and total move down with them.
      if (lastTable) {
        const { part } = lastTable;
        const bodyRows = Array.from(part.body.rows);
        const lastRow = bodyRows.at(-1);
        if (bodyRows.length > 1 && lastRow) {
          const moved = lastTable.continueOnNewSheet();
          moved.body.append(lastRow);
          if (part.footer) moved.table.append(part.footer);
        } else {
          part.section.style.marginTop = "0";
          sheet.append(part.section);
        }
      }
    }
    sheet.append(signOff.cloneNode(true));
  } catch (error) {
    console.error("Could not lay out the printed pages:", error);
    sheets.replaceChildren();
  } finally {
    probe.remove();
  }
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

  /* Layout and typography. These apply outside print too, so the document can
     be measured before printing (see paginatePrintDocument). */
  .report-print-page { width: 100%; border-collapse: collapse; border: 0; }
  .report-print-page > thead > tr > td { height: ${PRINT_PAGE_MM.top}mm; padding: 0; border: 0; }
  .report-print-page > tfoot > tr > td { height: ${PRINT_PAGE_MM.bottom}mm; padding: 0; border: 0; }
  .report-print-page > tbody > tr > td { padding: 0 ${PRINT_PAGE_MM.side}mm; border: 0; vertical-align: top; }
  .report-print-document {
    width: 100%;
    min-width: 0;
    color: #1f2937;
    font-family: Arial, Helvetica, sans-serif;
  }

  /* One sheet per printed page, laid out by paginatePrintDocument. Once the
     sheets are there, the flowing copy of the document is not printed. */
  .report-print-sheets:not(:empty) + .report-print-flow { display: none !important; }
  .report-print-sheet {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    width: ${PRINT_PAGE_MM.width}mm;
    height: ${PRINT_SHEET_HEIGHT_MM}mm;
    padding: ${PRINT_PAGE_MM.top}mm ${PRINT_PAGE_MM.side}mm ${PRINT_PAGE_MM.bottom}mm;
    break-after: page;
    page-break-after: always;
  }
  .report-print-sheet:last-child { break-after: auto; page-break-after: auto; }
  .report-print-sheet > * { flex: none; }
  .report-print-sheet > .report-print-signoff { margin-top: auto; padding-top: ${SIGN_OFF_GAP_MM}mm; }
  .report-print-flow .report-print-signoff { margin-top: ${SIGN_OFF_GAP_MM}mm; }
  .report-print-header,
  .report-print-meta,
  .report-print-summary,
  .report-print-signoff {
    break-inside: avoid-page;
    page-break-inside: avoid;
  }
  .report-print-header {
    display: grid;
    grid-template-columns: 26mm minmax(0, 1fr) 36mm;
    align-items: center;
    gap: 6mm;
  }
  .report-print-logo { display: block; width: 24mm; max-width: 100%; height: auto; aspect-ratio: 360 / 202; object-fit: contain; }
  .report-print-heading { min-width: 0; text-align: center; }
  .report-print-heading p { margin: 0; font-size: 8pt; letter-spacing: .08em; text-transform: uppercase; }
  .report-print-heading p:nth-child(2) { margin-top: 1mm; font-size: 7pt; letter-spacing: .03em; text-transform: none; }
  .report-print-heading h1 { margin: 3mm 0 2mm; font-size: 18pt; font-weight: 700; letter-spacing: .04em; overflow-wrap: anywhere; text-transform: uppercase; }
  .report-print-heading p:last-child { font-size: 7pt; font-weight: 700; }
  .report-print-generated { min-width: 0; margin: 0; overflow-wrap: anywhere; text-align: right; font-size: 7pt; line-height: 1.45; color: #4b5563; }
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
  .report-print-footer { display: grid; grid-template-columns: 1fr 1fr; gap: 30mm; font-size: 8pt; }
  .report-print-footer > div:last-child { text-align: right; }
  .report-print-footer span,
  .report-print-footer small { display: block; color: #4b5563; }
  .report-print-footer strong { display: block; margin-top: 6mm; }
  .report-print-footer div > div { margin-top: 2mm; border-bottom: .75pt solid #374151; }
  .report-print-timestamp { margin: 6mm 0 0; text-align: center; color: #6b7280; font-size: 7pt; }
`;

/**
 * Prints the rendered PrintDocument: waits for the logo, lays out the pages,
 * names the print (the browser uses it as the "Save as PDF" file name), opens
 * the print dialog, then calls onDone. A null title means nothing to print.
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
        // The logo must be decoded before the pages are measured.
        await Promise.all(
          Array.from(root.querySelectorAll("img"), (image) =>
            image.decode().catch(() => undefined),
          ),
        );
        if (cancelled) return;
        paginatePrintDocument(root);
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
