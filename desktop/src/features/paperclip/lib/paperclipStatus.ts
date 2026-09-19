export type PaperclipState = "stopped" | "running" | "error";

export type PaperclipStatus = {
  state: PaperclipState;
  url: string | null;
  error: string | null;
};

export function isEmbeddablePaperclipUrl(url: string | null): boolean {
  if (!url) return false;
  if (!URL.canParse(url)) return false;
  const protocol = URL.parse(url)?.protocol;
  return protocol === "http:" || protocol === "https:";
}

export function parsePaperclipStatus(value: unknown): PaperclipStatus {
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : undefined;
  const rawState = record?.state;
  const url =
    typeof record?.url === "string" && isEmbeddablePaperclipUrl(record.url)
      ? record.url
      : null;
  const state =
    rawState === "running" && url !== null
      ? "running"
      : rawState === "error"
        ? "error"
        : "stopped";
  const error = typeof record?.error === "string" ? record.error : null;
  return {
    state,
    url,
    error: state === "error" ? (error ?? "Paperclip failed to start") : null,
  };
}
