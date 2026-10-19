/**
 * Date/time display. UTC by default (the astronomical convention, and what FITS DATE-OBS uses);
 * each browser can switch to its local time zone in Admin settings.
 */

export type TimeZoneMode = "utc" | "local";
const STORAGE_KEY = "astroviabin.timeZone";

export function timeZoneMode(): TimeZoneMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === "local" ? "local" : "utc";
  } catch {
    return "utc";
  }
}

export function setTimeZoneMode(mode: TimeZoneMode): void {
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* storage unavailable */ }
}

function zone(): Intl.DateTimeFormatOptions {
  return timeZoneMode() === "utc" ? { timeZone: "UTC" } : {};
}

function valid(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "18 Oct 2026, 03:49 UTC" (or local time without the suffix). */
export function formatDateTime(value: string | number | Date | null | undefined, fallback = "—"): string {
  const date = valid(value);
  if (!date) return fallback;
  const text = date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", hourCycle: "h23", ...zone() });
  return timeZoneMode() === "utc" ? `${text} UTC` : text;
}

/** Calendar date in the display time zone. */
export function formatDate(value: string | number | Date | null | undefined, fallback = "—"): string {
  const date = valid(value);
  return date ? date.toLocaleDateString(undefined, { dateStyle: "medium", ...zone() }) : fallback;
}

/** "Oct 18" in the display time zone. */
export function formatShortDate(value: string | number | Date | null | undefined): string | null {
  const date = valid(value);
  return date ? date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...zone() }) : null;
}

/** Value for an <input type="datetime-local"> in the display time zone. */
export function toDateTimeInput(value: string | Date | null | undefined): string {
  const date = valid(value);
  if (!date) return "";
  const utc = timeZoneMode() === "utc";
  const pad = (n: number) => String(n).padStart(2, "0");
  const [year, month, day, hours, minutes] = utc
    ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes()]
    : [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes()];
  return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}`;
}

/** Parses an <input type="datetime-local"> value written in the display time zone. */
export function fromDateTimeInput(value: string): Date | null {
  if (!value) return null;
  const date = new Date(timeZoneMode() === "utc" ? `${value}:00Z` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function timeZoneLabel(): string {
  return timeZoneMode() === "utc" ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
}
