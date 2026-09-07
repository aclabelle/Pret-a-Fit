/* ═══════════════════════════════════════════════════════════════════════════
   Prêt-à-Fit — /api/search

   Handles three different jobs, told apart by the "mode" the frontend sends:
     'search'   — product search (uses web_search, needs lots of tokens)
     'fitcheck' — verdict on one garment (no web search, medium tokens)
     'quiz'     — short body/colour analysis (no web search, few tokens)
   Plus a separate "validateUrls" mode used by the link checker.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── Abuse / cost protection ──────────────────────────────────────────────
   This endpoint spends real money on every call, so it should only answer
   requests coming from your own site. If you ever need to call it from
   somewhere else (a test tool, Postman, a new domain), either add the domain
   to ALLOWED_ORIGIN_HOSTS below or set REQUIRE_KNOWN_ORIGIN to false.
   ──────────────────────────────────────────────────────────────────────── */
const REQUIRE_KNOWN_ORIGIN = true;

const ALLOWED_ORIGIN_HOSTS = [
  'pret-a-fit.com',
  'www.pret-a-fit.com',
  'localhost',
  '127.0.0.1'
];

function isAllowedOrigin(originHeader) {
  if (!originHeader) return false;
  try {
    const host = new URL(originHeader).hostname.toLowerCase();
    if (ALLOWED_ORIGIN_HOSTS.includes(host)) return true;
    // Vercel preview deployments (e.g. pret-a-fit-abc123.vercel.app)
    if (host.endsWith('.vercel.app')) return true;
    return false;
  } catch {
    return false;
  }
}

const BROWSER_HEADERS = {
  // Mimic a real browser so retailers don't block the request
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*'
};

// Phrases that show up on "soft 404" pages — pages that return a normal 200 OK
// status but are actually a "we couldn't find that" or "item unavailable" page.
const DEAD_PAGE_PHRASES = [
  'page not found', "page you're looking for", '404 error', '404 not found',
  'product not found', 'item not found', 'no longer available',
  "we can't find that page", "we couldn't find that page", 'this page is not available',
  "this page isn't available", 'sorry, this item', 'item is no longer available',
  'product is no longer available', 'no longer sold', 'this product has been discontinued',
  "oops! that page can't be found"
];
// Deliberately NOT included: 'sold out' / 'out of stock'. These appear on
// perfectly good product pages where just one size is unavailable, so
// matching on them would throw away results you want to keep.

// Never let the link checker fetch internal / private addresses. Without this,
// anyone who found this endpoint could use your server to probe machines that
// aren't reachable from the public internet.
const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i, /^127\./, /^0\./, /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[01])\./, /^169\.254\./, /^\[?::1\]?$/, /\.local$/i,
  /^metadata\./i
];

const MAX_URLS_PER_CHECK = 40;

function isCheckableUrl(url) {
  if (typeof url !== 'string' || url.length > 2000) return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (PRIVATE_HOST_PATTERNS.some(p => p.test(u.hostname))) return false;
    return true;
  } catch {
    return false;
  }
}

// If a URL redirects somewhere far shallower than where it started (e.g. a
// specific product page bouncing to the site's homepage or top-level shop
// page), that's a classic sign the original product no longer exists.
function looksLikeHomepageRedirect(originalUrl, finalUrl) {
  try {
    const o = new URL(originalUrl);
    const f = new URL(finalUrl);
    if (o.hostname.replace(/^www\./, '') !== f.hostname.replace(/^www\./, '')) return true;
    const oDepth = o.pathname.split('/').filter(Boolean).length;
    const fDepth = f.pathname.split('/').filter(Boolean).length;
    return oDepth > 1 && fDepth <= 1;
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, method) {
  return fetch(url, {
    method,
    redirect: 'follow',
    signal: AbortSignal.timeout(8000),
    headers: BROWSER_HEADERS
  });
}

async function checkUrl(url) {
  if (!isCheckableUrl(url)) return { url, alive: false };

  try {
    let r = await fetchWithTimeout(url, 'HEAD');
    let usedGet = false;

    // A lot of retailers block or mishandle HEAD requests — if we get a
    // status that looks like that rather than a real answer, retry with GET.
    if ([405, 501, 403].includes(r.status)) {
      r = await fetchWithTimeout(url, 'GET');
      usedGet = true;
    }

    // Hard failure statuses — clearly dead.
    if (r.status === 404 || r.status === 410) return { url, alive: false };

    // 403/429/5xx — likely bot-blocking or a temporary hiccup, not a dead
    // product. Keep it rather than risk hiding a perfectly good link.
    if (r.status >= 400) return { url, alive: true };

    const isHtml = (r.headers.get('content-type') || '').includes('text/html');

    // Landed on the homepage/top-level shop page instead of a product page —
    // strong signal the specific product is gone. Confirm with a content
    // check before condemning it, since some sites route this way
    // intentionally without the product actually being unavailable.
    //
    // NOTE: a HEAD response has no body, so we must re-fetch with GET to read
    // anything. The previous version read the empty HEAD body and always came
    // back blank, which meant this check silently never fired.
    if (looksLikeHomepageRedirect(url, r.url)) {
      const bodyText = await readPageText(r, url, usedGet);
      if (bodyText && DEAD_PAGE_PHRASES.some(p => bodyText.includes(p))) {
        return { url, alive: false };
      }
      // Redirected but no clear "not found" language — uncertain, keep it.
      return { url, alive: true };
    }

    // Normal 200-series response on what looks like the right page. If we
    // already pulled the HTML (because we fell back to GET), scan it for
    // soft-404 wording before trusting the status code. We don't spend an
    // extra GET here — that would double the time of every single search.
    if (usedGet && isHtml) {
      const bodyText = await readPageText(r, url, true);
      if (bodyText && DEAD_PAGE_PHRASES.some(p => bodyText.includes(p))) {
        return { url, alive: false };
      }
    }

    return { url, alive: true };
  } catch {
    // Network timeout, DNS failure, etc. — uncertain, not necessarily dead.
    return { url, alive: true };
  }
}

// Reads a slice of the page as lowercase text. If all we have is a HEAD
// response (no body), fetch the page properly first.
async function readPageText(response, url, alreadyHaveBody) {
  try {
    let r = response;
    if (!alreadyHaveBody) {
      r = await fetchWithTimeout(url, 'GET');
      if (!(r.headers.get('content-type') || '').includes('text/html')) return '';
    }
    const full = await r.text();
    return full.slice(0, 6000).toLowerCase();
  } catch {
    return '';
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (REQUIRE_KNOWN_ORIGIN && !isAllowedOrigin(req.headers.origin)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const {
    prompt, imageBase64, imageMediaType,
    image2Base64, image2MediaType, validateUrls, mode
  } = req.body;

  // ── URL validation mode ──────────────────────────────────────────────────
  // The frontend sends a list of URLs and we check which ones are alive.
  if (validateUrls) {
    const submitted = Array.isArray(req.body.urls) ? req.body.urls : [];
    // Cap the batch so this can't be turned into a bulk scanning tool.
    const urls = submitted.slice(0, MAX_URLS_PER_CHECK);
    const results = await Promise.all(urls.map(checkUrl));
    return res.status(200).json({ results });
  }

  // ── Normal search / fit check / quiz mode ────────────────────────────────
  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  // Work out what kind of request this is. The frontend now sends an explicit
  // "mode", but we still fall back to reading the prompt so that any older
  // cached copy of the frontend keeps working.
  const looksLikeSearch = typeof prompt === 'string' && prompt.includes('Fashion search engine');
  const resolvedMode = mode || (looksLikeSearch ? 'search' : 'quiz');
  const isOutfitSearch = resolvedMode === 'search';
  const isFitCheck = resolvedMode === 'fitcheck';

  let messageContent;
  if (imageBase64 && image2Base64) {
    // Camera capture: two images (front + side)
    messageContent = [
      { type: 'image', source: { type: 'base64', media_type: imageMediaType || 'image/jpeg', data: imageBase64 } },
      { type: 'image', source: { type: 'base64', media_type: image2MediaType || 'image/jpeg', data: image2Base64 } },
      { type: 'text', text: prompt }
    ];
  } else if (imageBase64) {
    messageContent = [
      { type: 'image', source: { type: 'base64', media_type: imageMediaType || 'image/jpeg', data: imageBase64 } },
      { type: 'text', text: prompt }
    ];
  } else {
    messageContent = prompt;
  }

  const requestBody = {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: messageContent }]
  };

  if (isOutfitSearch) {
    requestBody.max_tokens = 4000;
    requestBody.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    requestBody.system = `You are a fashion search assistant. You MUST follow these rules strictly:

LINKS — this is critical:
- Every "url" field must be a direct, specific product page URL (e.g. https://www.net-a-porter.com/en-gb/shop/product/123456). Never use search pages, category pages, or homepage URLs.
- Before including a URL, verify it leads directly to that exact product by checking the page in your web search results.
- Strongly prefer large, stable retailers with reliable URLs: Net-a-Porter, Mytheresa, Farfetch, Nordstrom, SSENSE, ASOS, Selfridges, Saks Fifth Avenue, Neiman Marcus, Shopbop, Revolve, COS, Arket, Zara, Uniqlo, Mr Porter, End Clothing, J.Crew. These retailers keep product pages live longer.
- Do not include URLs from small boutiques, pop-up shops, or retailers with complex/dynamic URL structures.
- Never recommend a retailer that has closed down. Do not use Matches / MatchesFashion — that business went into administration and its website closed.
- If you are not confident a product URL is live and correct, do not include that product — find another one instead.

IMAGES:
- The "imageUrl" must be a direct CDN image URL ending in .jpg, .jpeg, .png, or .webp. No redirect URLs, no tracking URLs.

Respond with a raw JSON array only. No markdown, no preamble, no explanation.`;
  } else if (isFitCheck) {
    // A fit check writes several paragraphs of assessment, so 500 tokens
    // (the quiz limit) would cut the reply off mid-sentence and produce
    // broken JSON. No web search — the verdict comes from the photo alone,
    // which is what makes this feature cheap.
    requestBody.max_tokens = 1500;
    requestBody.system = 'You are a warm but genuinely honest personal stylist. You must respond with valid JSON only — no preamble, no explanation, no markdown, no code fences. Your entire response must be a single JSON object starting with { and ending with }. Never criticise the person; assess only the garment and how it works for them.';
  } else {
    requestBody.max_tokens = 500;
    requestBody.system = 'You are a helpful assistant. You must respond with valid JSON only — no preamble, no explanation, no markdown, no code fences. Your entire response must be a single JSON object starting with { and ending with }.';
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': process.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01'
  };
  if (isOutfitSearch) {
    headers['anthropic-beta'] = 'web-search-2025-03-05';
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data.error?.message || JSON.stringify(data);
      console.error('Anthropic API error:', response.status, errMsg);
      return res.status(response.status).json({ error: errMsg });
    }

    const result = (data.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // If the model ran out of room mid-reply the JSON will be unparseable at
    // the other end. Say so clearly rather than letting it look like a crash.
    if (data.stop_reason === 'max_tokens') {
      console.error('Reply truncated by max_tokens, mode:', resolvedMode);
      return res.status(500).json({ error: 'The reply was cut short — please try again.' });
    }

    return res.status(200).json({ result });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
