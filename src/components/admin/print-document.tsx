import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import exportLogoUrl from "@/assets/export-logo.png";
import { SHOP_EXPORT_NAME, SHOP_OWNER_NAME } from "@/lib/export-branding";
import { PRINT_DOCUMENT_STYLES } from "@/lib/print-document";
import { SHOP } from "@/lib/shop";

export type PrintDocumentInfo = {
  title: string;
  /** An optional small line under the title, e.g. "Activity record". */
  subtitle?: string;
  generatedAt: string;
  coverage: string;
  scope: string;
};

/**
 * A printable document: the shop header, coverage and scope, the given
 * sections, and the Prepared by / Approved by sign-off. It is hidden on screen
 * and printed with usePrintWhenReady (lib/print-document.ts).
 */
export function PrintDocument({
  info,
  children,
}: {
  info: PrintDocumentInfo | null;
  children?: ReactNode;
}) {
  if (!info || typeof document === "undefined") return null;

  return createPortal(
    <div className="report-print-root">
      <style>{PRINT_DOCUMENT_STYLES}</style>
      <div className="report-print-sheets" />
      {/* Printed only if the document could not be laid out on sheets. */}
      <table className="report-print-page report-print-flow">
        <thead>
          <tr>
            <td />
          </tr>
        </thead>
        <tfoot>
          <tr>
            <td />
          </tr>
        </tfoot>
        <tbody>
          <tr>
            <td>
              <article className="report-print-document">
                <div className="report-print-content">
                  <header className="report-print-header">
                    <img src={exportLogoUrl} alt="" className="report-print-logo" />
                    <div className="report-print-heading">
                      <p>{SHOP_EXPORT_NAME}</p>
                      <p>{SHOP.tagline}</p>
                      <h1>{info.title}</h1>
                      {info.subtitle && <p>{info.subtitle}</p>}
                    </div>
                    <p className="report-print-generated">
                      Generated
                      <br />
                      {info.generatedAt}
                    </p>
                  </header>
                  <div className="report-print-rule" />
                  <section className="report-print-meta">
                    <div>
                      <span>Coverage</span>
                      <strong>{info.coverage}</strong>
                    </div>
                    <div>
                      <span>Report scope</span>
                      <strong>{info.scope}</strong>
                    </div>
                  </section>
                  {children}
                </div>
                <div className="report-print-signoff">
                  <footer className="report-print-footer">
                    <div>
                      <span>Prepared by</span>
                      <div />
                    </div>
                    <div>
                      <span>Approved by</span>
                      <strong>{SHOP_OWNER_NAME}</strong>
                      <small>Shop Owner</small>
                      <div />
                    </div>
                  </footer>
                  <p className="report-print-timestamp">Generated on {info.generatedAt}</p>
                </div>
              </article>
            </td>
          </tr>
        </tbody>
      </table>
    </div>,
    document.body,
  );
}

/** A titled table section of a PrintDocument. Long tables continue across pages. */
export function PrintTable({
  title,
  headers,
  columnWidths,
  rows,
  footerRow,
  emptyMessage,
  lastColumn = "amount",
}: {
  title: string;
  headers: string[];
  columnWidths?: string[];
  rows: string[][];
  footerRow?: string[];
  emptyMessage: string;
  /** An amount column is right-aligned; a text column stays left-aligned. */
  lastColumn?: "amount" | "text";
}) {
  return (
    <section className="report-print-section">
      <h2>{title}</h2>
      <table
        className={
          lastColumn === "text" ? "report-print-table report-print-text-end" : "report-print-table"
        }
      >
        {columnWidths && (
          <colgroup>
            {columnWidths.map((width, index) => (
              <col key={`${width}-${index}`} style={{ width }} />
            ))}
          </colgroup>
        )}
        <thead>
          <tr>
            {headers.map((header) => (
              <th key={header}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.join("-")}-${index}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${cell}-${cellIndex}`}>{cell}</td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={headers.length}>{emptyMessage}</td>
            </tr>
          )}
        </tbody>
        {footerRow && rows.length > 0 && (
          <tfoot>
            <tr>
              {footerRow.map((cell, index) => (
                <td key={`${cell}-${index}`}>{cell}</td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </section>
  );
}
