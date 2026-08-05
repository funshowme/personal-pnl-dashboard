const ALLOWED_ORIGIN = "https://funshowme.github.io";
const CACHE_SECONDS = 300;
const YAHOO_ORIGIN = "https://query1.finance.yahoo.com";
const QUOTES = [
  { symbol: "2327.TW", currency: "TWD" },
  { symbol: "0050.TW", currency: "TWD" },
  { symbol: "NVDA", currency: "USD" },
  { symbol: "USDTWD=X", currency: "TWD" },
];

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Vary": "Origin",
};

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders, ...headers },
  });
}

function latestClose(result) {
  const closes = result?.indicators?.quote?.[0]?.close ?? [];
  for (let index = closes.length - 1; index >= 0; index -= 1) {
    const price = Number(closes[index]);
    if (Number.isFinite(price)) return price;
  }
  return null;
}

async function yahooQuote(item) {
  const url = new URL(`/v8/finance/chart/${encodeURIComponent(item.symbol)}`, YAHOO_ORIGIN);
  url.searchParams.set("range", "1d");
  url.searchParams.set("interval", "1m");
  url.searchParams.set("events", "history");
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Referer": "https://finance.yahoo.com/",
      "User-Agent": "Mozilla/5.0 (compatible; PersonalPnLDashboard/1.0)",
    },
  });
  const payload = await response.json().catch(() => ({}));
  const result = payload.chart?.result?.[0];
  const price = Number(result?.meta?.regularMarketPrice);
  const finalPrice = Number.isFinite(price) ? price : latestClose(result);
  if (!response.ok || !Number.isFinite(finalPrice)) {
    throw new Error(`${item.symbol}: Yahoo Finance returned no usable price (${response.status})`);
  }
  const time = Number(result?.meta?.regularMarketTime);
  return {
    symbol: item.symbol,
    price: finalPrice,
    currency: item.currency,
    marketTime: Number.isFinite(time) ? new Date(time * 1000).toISOString() : null,
  };
}

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (origin && origin !== ALLOWED_ORIGIN) return json({ error: "Origin not allowed" }, 403);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
    if (request.method !== "GET" || url.pathname !== "/quotes") return json({ error: "Use GET /quotes" }, 404);

    const cache = caches.default;
    const cached = await cache.match(request);
    if (cached) return cached;

    const settled = await Promise.allSettled(QUOTES.map(yahooQuote));
    const data = settled.filter(result => result.status === "fulfilled").map(result => result.value);
    const errors = settled.filter(result => result.status === "rejected").map(result => result.reason.message);
    const response = json(
      { data, errors, updatedAt: new Date().toISOString(), source: "Yahoo Finance" },
      data.length ? 200 : 502,
      { "Cache-Control": `public, max-age=${CACHE_SECONDS}` },
    );
    if (data.length) ctx.waitUntil(cache.put(request, response.clone()));
    return response;
  },
};
