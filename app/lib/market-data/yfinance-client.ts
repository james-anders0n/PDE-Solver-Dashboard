export interface YFinanceQuote {
  symbol: string;
  currency: string;
  timezone: string;
  regularMarketPrice: number;
  regularMarketTime: string;
}

export interface YFinanceHistoryPoint {
  date: string;
  close: number;
  adjustedClose: number;
  volume: number;
  dividends: number;
  splits: number;
}

export interface YFinanceOptionContract {
  contractSymbol: string;
  optionType: "call" | "put";
  expiration: string;
  strike: number;
  bid: number;
  ask: number;
  lastPrice: number;
  impliedVolatility?: number;
  openInterest: number;
  volume: number;
  lastTradeTimestamp?: string;
}

async function request<T>(baseUrl: string, path: string, query: Record<string, string>, signal?: AbortSignal): Promise<T> {
  if (!baseUrl) throw new Error("YFINANCE_SERVICE_URL is not configured on the server.");
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`yfinance service request failed with status ${response.status}.`);
  return await response.json() as T;
}

export const fetchYFinanceQuote = (baseUrl: string, symbol: string, signal?: AbortSignal) =>
  request<YFinanceQuote>(baseUrl, "quote", { symbol }, signal);

export const fetchYFinanceHistory = (baseUrl: string, symbol: string, start: string, end: string, signal?: AbortSignal) =>
  request<{ symbol: string; currency: string; points: YFinanceHistoryPoint[] }>(baseUrl, "history", { symbol, start, end }, signal);

export const fetchYFinanceExpirations = (baseUrl: string, symbol: string, signal?: AbortSignal) =>
  request<{ symbol: string; expirations: string[] }>(baseUrl, "expirations", { symbol }, signal);

export const fetchYFinanceOptionChain = (baseUrl: string, symbol: string, expiration: string, signal?: AbortSignal) =>
  request<{ symbol: string; currency: string; expiration: string; contracts: YFinanceOptionContract[] }>(baseUrl, "option-chain", { symbol, expiration }, signal);
