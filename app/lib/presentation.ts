import type { ValueUnit } from "./market-data/types.ts";

const UTC_DATE_TIME = new Intl.DateTimeFormat("en-AU", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const UTC_DATE = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function formatUtcDateTime(value: string | null | undefined, fallback = "Not recorded"): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : `${UTC_DATE_TIME.format(parsed)} UTC`;
}

export function formatUtcDate(value: string | null | undefined, fallback = "Not recorded"): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : `${UTC_DATE.format(parsed)} UTC`;
}

export function decimalToPercent(value: string | number, digits = 4): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value);
  return `${(numeric * 100).toLocaleString("en-AU", { maximumFractionDigits: digits })}%`;
}

export function decimalToPercentInput(value: string | number): string {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Number((numeric * 100).toPrecision(15))) : String(value);
}

export function percentInputToDecimal(value: string): string {
  if (value.trim() === "") return "";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Number((numeric / 100).toPrecision(15))) : value;
}

export function formatEvidenceValue(value: string | number | null | undefined, unit?: ValueUnit | string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (unit === "decimal" || unit === "dec") return decimalToPercent(value);
  if (unit === "percent") return `${value}%`;
  return String(value);
}

export function displayUnit(unit?: ValueUnit | string): string {
  if (unit === "decimal" || unit === "dec" || unit === "percent") return "%";
  return unit ?? "";
}
