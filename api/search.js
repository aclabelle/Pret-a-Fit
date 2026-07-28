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
  try {
    let r = await fetchWithTimeout(url, 'HEAD');

    // A lot of retailers block or mishandle HEAD requests — if we get a
    // status that looks like that rather than a real answer, retry with GET.
    if ([405, 501, 403].includes(r.status)) {
      r = await fetchWithTimeout(url, 'GET');
    }

    // Hard failure statuses — clearly dead.
    if (r.status === 404 || r.status === 410) return { url, alive: false };

    // 403/429/5xx — likely bot-blocking or a temporary hiccup, not a dead
    // product. Keep it rather than risk hiding a perfectly good link.
    if (r.status >= 400) return { url, alive: true };

    // Landed on the homepage/top-level shop page instead of a product page —
    // strong signal the specific product is gone. Confirm with a quick
    // content check before condemning it, since some sites route this way
    // intentionally without the product actually being unavailable.
    if (looksLikeHomepageRedirect(url, r.url)) {
      const bodyText = await safeReadText(r, url);
      if (bodyText && DEAD_PAGE_PHRASES.some(p => bodyText.includes(p))) {
        return { url, alive: false };
      }
      // Redirected but no clear "not found" language — treat as uncertain, keep it.
      return { url, alive: true };
    }

    // Normal 200-series response on what looks like the right page. If we
    // already have the HTML in hand (because we had to fall back to GET),
    // do a cheap scan for soft-404 wording before trusting the status code.
    if (r.status < 400 && r.bodyUsed === false && (r.headers.get('content-type') || '').includes('text/html')) {
      const bodyText = await safeReadText(r, url);
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

// Reads a small slice of the response body as lowercase text, tolerating
// responses that can't be read (e.g. a HEAD response has no body).
async function safeReadText(response, url) {
  try {
    const full = await response.text();
    return full.slice(0, 6000).toLowerCase();
  } catch {
    return '';
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, imageBase64, imageMediaType, image2Base64, image2MediaType, validateUrls } = req.body;

  // ── URL validation mode ──────────────────────────────────────────────────
  // The frontend sends a list of URLs and we check which ones are alive.
  if (validateUrls) {
    const urls = req.body.urls || [];
    const results = await Promise.all(urls.map(checkUrl));
    return res.status(200).json({ results });
  }

  // ── Normal search / quiz mode ────────────────────────────────────────────
  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  const isOutfitSearch = typeof prompt === 'string' && prompt.includes('Fashion search engine');

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
    // Option 1: system prompt that enforces live, stable URLs
    requestBody.system = `You are a fashion search assistant. You MUST follow these rules strictly:

LINKS — this is critical:
- Every "url" field must be a direct, specific product page URL (e.g. https://www.net-a-porter.com/en-gb/shop/product/123456). Never use search pages, category pages, or homepage URLs.
- Before including a URL, verify it leads directly to that exact product by checking the page in your web search results.
- Strongly prefer large, stable retailers with reliable URLs: Net-a-Porter, Mytheresa, Farfetch, Nordstrom, ASOS, Matches Fashion, Selfridges, Browns Fashion, MatchesFashion, Saks Fifth Avenue, Neiman Marcus, Shopbop, Revolve. These retailers keep product pages live longer.
- Do not include URLs from small boutiques, pop-up shops, or retailers with complex/dynamic URL structures.
- If you are not confident a product URL is live and correct, do not include that product — find another one instead.

IMAGES:
- The "imageUrl" must be a direct CDN image URL ending in .jpg, .jpeg, .png, or .webp. No redirect URLs, no tracking URLs.

Respond with a raw JSON array only. No markdown, no preamble, no explanation.`;
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

    return res.status(200).json({ result });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
