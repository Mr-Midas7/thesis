import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { jsPDF } from "jspdf";

const scriptDirectory = fileURLToPath(new URL(".", import.meta.url));
const projectDirectory = join(scriptDirectory, "..");
const outputDirectory = join(projectDirectory, "docs", "source-code");
const obsoleteHtmlPath = join(outputDirectory, "fake-rider-frontend-source-code.html");
const pageLimit = 20;
const codeOnlyDocuments = [
  {
    name: "frontend",
    outputPath: join(outputDirectory, "fake-rider-frontend-source-code.pdf"),
    sourceFilePath: join(projectDirectory, "src", "routes", "book.tsx"),
    subject: "Frontend booking page source code",
    title: "Fake Rider Frontend Source Code",
  },
  {
    name: "backend",
    outputPath: join(outputDirectory, "fake-rider-backend-source-code.pdf"),
    sourceFilePath: join(projectDirectory, "src", "lib", "booking.functions.ts"),
    subject: "Backend booking server-function source code",
    title: "Fake Rider Backend Source Code",
  },
];
const requestedDocument = process.argv[2];
const documentsToGenerate = requestedDocument
  ? codeOnlyDocuments.filter(({ name }) => name === requestedDocument)
  : codeOnlyDocuments;

if (requestedDocument && documentsToGenerate.length === 0) {
  throw new Error(`Unknown document type: ${requestedDocument}. Use frontend or backend.`);
}

function generateCodeOnlyPdf({ outputPath, sourceFilePath, subject, title }) {
  const document = new jsPDF({
    compress: true,
    format: "letter",
    orientation: "portrait",
    unit: "pt",
  });
  const arialPath = join(process.env.WINDIR ?? "C:\\Windows", "Fonts", "arial.ttf");
  const leftMargin = 108;
  const topMargin = 72;
  const rightMargin = 72;
  const bottomMargin = 72;
  const pageWidth = document.internal.pageSize.getWidth();
  const pageHeight = document.internal.pageSize.getHeight();
  const contentWidth = pageWidth - leftMargin - rightMargin;
  const contentBottom = pageHeight - bottomMargin;
  const lineHeight = 14.4;
  const sourceLines = readFileSync(sourceFilePath, "utf8")
    .replace(/^\uFEFF/, "")
    .replaceAll("\t", "    ")
    .split(/\r?\n/);
  let cursorY = topMargin;
  let truncatedAtLimit = false;

  document.addFileToVFS("Arial.ttf", readFileSync(arialPath).toString("base64"));
  document.addFont("Arial.ttf", "Arial", "normal");
  document.setProperties({
    author: "Fake Rider Motorcycle Repair Shop",
    subject,
    title,
  });
  document.setFont("Arial", "normal");
  document.setFontSize(12);
  document.setTextColor(0, 0, 0);

  sourceLoop: for (const sourceLine of sourceLines) {
    const wrappedLines = document.splitTextToSize(sourceLine, contentWidth);
    for (const wrappedLine of wrappedLines.length ? wrappedLines : [""]) {
      if (cursorY + lineHeight > contentBottom) {
        if (document.getNumberOfPages() === pageLimit) {
          truncatedAtLimit = true;
          break sourceLoop;
        }
        document.addPage("letter", "portrait");
        cursorY = topMargin;
        document.setFont("Arial", "normal");
        document.setFontSize(12);
      }

      document.text(wrappedLine, leftMargin, cursorY);
      cursorY += lineHeight;
    }
  }

  if (!truncatedAtLimit || document.getNumberOfPages() !== pageLimit) {
    throw new Error(`Expected a continuous ${pageLimit}-page code sample.`);
  }

  writeFileSync(outputPath, Buffer.from(document.output("arraybuffer")));
}

if (!existsSync(outputDirectory)) mkdirSync(outputDirectory, { recursive: true });
if (existsSync(obsoleteHtmlPath)) rmSync(obsoleteHtmlPath);
for (const codeOnlyDocument of documentsToGenerate) {
  generateCodeOnlyPdf(codeOnlyDocument);
  console.log(
    `Generated ${codeOnlyDocument.outputPath} with ${pageLimit} pages of continuous code.`,
  );
}
