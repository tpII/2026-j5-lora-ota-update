/**
 * Files the panel hands to the browser to save: measurement exports without the File System Access
 * API and the private key of a pair generated in the panel.
 */

const MEDIA_TYPES: { readonly [Extension: string]: string } = {
  json: "application/json",
  jsonl: "application/x-ndjson",
  csv: "text/csv",
  pem: "application/x-pem-file",
};

export function mediaTypeOf(fileName: string): string {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1);
  return MEDIA_TYPES[extension] ?? "text/plain";
}

export function downloadTextFile(fileName: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mediaTypeOf(fileName) }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoke later: the download starts asynchronously.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
