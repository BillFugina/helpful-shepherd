// PDF.js ships no types for its worker module. The server only hands the
// module back to PDF.js (see server/contracts/pdf.ts), so its shape doesn't matter.
declare module 'pdfjs-dist/legacy/build/pdf.worker.mjs' {
  export const WorkerMessageHandler: unknown
}
