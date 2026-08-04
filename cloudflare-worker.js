const ALLOWED_ORIGIN = "https://funshowme.github.io";
const CACHE_SECONDS = 300;
const FINMIND_API = "https://api.finmindtrade.com/api/v4";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
      ...extraHeaders,
    },
  });
}

function isoDate(daysAgo = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function latestRow(rows) {
  return Array.isArray(rows) && rows.length
    ? [...rows].sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? ""))).at(-1)
    : null;
}

function finiteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

async function finmind(url, token) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.status === 402 || payload.status === 401) {
    throw new Error(payload.msg || `FinMind request failed (${response.status})`);
  }
  return payload.data ?? [];
}

async function taiwanQuote(stockId, token) {
  const url = new URL(`${FINMIND_API}/data`);
  url.searchParams.set("dataset", "TaiwanStockPrice");
  url.searchParams.set("data_id", stockId);
  url.searchParams.set("start_date", isoDate(10));
  const row = latestRow(await finmind(url, token));
  const price = row && finiteNumber(row.close, row.Close, row.deal_price);
  if (price === null) throw new Error(`${stockId}: price unavailable`);
  return { symbol: `${stockId}.TW`, price, currency: "TWD", marketTime: row.date ?? null };
}

async function usQuote(token) {
  const url = new URL(`${FINMIND_API}/data`);
  url.searchParams.set("dataset", "USStockPrice");
  url.searchParams.set("data_id", "NVDA");
  url.searchParams.set("start_date", isoDate(10));
  const row = latestRow(await finmind(url, token));
  const price = row && finiteNumber(row.close, row.Close, row.Adj_Close);
  if (price === null) throw new Error("NVDA: price unavailable");
  return { symbol: "NVDA", price, currency: "USD", marketTime: row.date ?? null };
}

async function usdTwdQuote(token) {
  const url = new URL(`${FINMIND_API}/data`);
  url.searchParams.set("dataset", "TaiwanExchangeRate");
  url.searchParams.set("data_id", "USD");
  url.searchParams.set("start_date", isoDate(10));
  const row = latestRow(await finmind(url, token));
  const buy = row && finiteNumber(row.spot_buy, row.cash_buy, row.buy, row.rate);
  const sell = row && finiteNumber(row.spot_sell, row.cash_sell, row.sell);
  const price = buy !== null && sell !== null ? (buy + sell) / 2 : buy;
  if (price === null) throw new Error("USD/TWD: price unavailable");
  return { symbol: "USDTWD=X", price, currency: "TWD", marketTime: row.date ?? null };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (origin && origin !== ALLOWED_ORIGIN) return json({ error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== "GET" || url.pathname !== "/quotes") {
      return json({ error: "Use GET /quotes" }, 404);
    }
    if (!env.FINMIND_TOKEN) return json({ error: "Server configuration is incomplete" }, 500);

    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    const tasks = [taiwanQuote("2327", env.FINMIND_TOKEN), taiwanQuote("0050", env.FINMIND_TOKEN), usQuote(env.FINMIND_TOKEN), usdTwdQuote(env.FINMIND_TOKEN)];
    const settled = await Promise.allSettled(tasks);
    const data = settled.filter((result) => result.status === "fulfilled").map((result) => result.value);
    const errors = settled.filter((result) => result.status === "rejected").map((result) => result.reason.message);
    const response = json(
      { data, errors, updatedAt: new Date().toISOString(), source: "FinMind" },
      data.length ? 200 : 502,
      { "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
    );
    ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  },
};
