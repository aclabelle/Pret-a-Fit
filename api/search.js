/* ═══════════════════════════════════════════════════════════════════════════
   Prêt-à-Fit — /api/search

   Handles four different jobs, told apart by the "mode" the frontend sends:
     'search'   — product search (uses web_search, needs lots of tokens)
     'fitcheck' — verdict on one garment (no web search, medium tokens)
     'guide'    — personal shopping guide (no web search, most tokens of the
                  non-search modes; it's the longest structured reply here)
     'quiz'     — short body/colour analysis (no web search, few tokens)
   Plus a separate "validateUrls" mode used by the link checker.

   Anything with no recognised mode falls through to 'quiz' and its 500-token
   limit, which will cut a long reply off mid-sentence. Any NEW prompt type
   must therefore send its own mode and get its own branch below.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── Abuse / cost protection ──────────────────────────────────────────────
   This endpoint spends real money on every call, so it should only answer
   requests coming from your own site. If you ever need to call it from
   somewhere else (a test tool, Postman, a new domain), either add the domain
   to ALLOWED_ORIGIN_HOSTS below or set REQUIRE_KNOWN_ORIGIN to false.
   ──────────────────────────────────────────────────────────────────────── */
const REQUIRE_KNOWN_ORIGIN = true;

/* ── Cost logging ─────────────────────────────────────────────────────────
   Every call to this endpoint spends real money, and until now nobody knew
   how much. The spec has said "max 3 searches per request to control cost"
   since July, but no such cap was ever set in the code (see the web_search
   tool below — there is no `max_uses`), so the model runs as many searches
   as it decides it needs. Comparison-style questions can run ten or more.

   So every call now logs what it actually used. Find these in Vercel →
   your project → the Logs tab, and filter for "[COST]".

   The token counts and the search count come straight from the API and are
   exact. The dollar figure is worked out from the two rates below.
   ⚠️ VERIFY THESE RATES at claude.com/pricing before trusting the estimate —
   they are the published rates for this model family, not a quote. The raw
   numbers on each log line stay correct either way, so the estimate being
   off does not spoil the measurement.
   ──────────────────────────────────────────────────────────────────────── */
const PRICE_PER_MTOK_INPUT  = 3.00;   // USD per 1,000,000 input tokens
const PRICE_PER_MTOK_OUTPUT = 15.00;  // USD per 1,000,000 output tokens
const PRICE_PER_WEB_SEARCH  = 0.01;   // USD per search ($10 per 1,000)

function logCost(mode, usage) {
  if (!usage) { console.log('[COST] mode=' + mode + ' usage=unavailable'); return; }

  const inTok  = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  // Cached tokens are billed differently, but nothing here uses caching yet.
  const cacheRead  = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const searches = (usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;

  const dollars = (inTok  / 1e6) * PRICE_PER_MTOK_INPUT
                + (outTok / 1e6) * PRICE_PER_MTOK_OUTPUT
                + searches * PRICE_PER_WEB_SEARCH;

  console.log(
    '[COST] mode=' + mode +
    ' searches=' + searches +
    ' in=' + inTok +
    ' out=' + outTok +
    (cacheRead || cacheWrite ? ' cacheRead=' + cacheRead + ' cacheWrite=' + cacheWrite : '') +
    ' est=$' + dollars.toFixed(4)
  );
}

/* ── Grounding: every product link must come from the search itself ───────
   Added 26 Nov 2026 after testing found invented links: a "Leisure Lab Linen
   Resort Short" whose link was a real Nordstrom page for a play mat (the AI
   made up a product number), and an Isabel Marant dress pointing at
   Mytheresa's beach-dresses listing.

   The prompts have always said "only use URLs from your search results", but
   nothing enforced it. Now it is enforced here: the API hands back every page
   the web search returned (web_search_tool_result blocks, plus citations), and
   any product whose link isn't among them is dropped before the browser ever
   sees it. The model can only know a real product link if a search returned
   it — anything else was constructed.

   Links are compared on host (ignoring "www.") and path (ignoring case and a
   trailing slash). Query strings are ignored, because retailers add and drop
   tracking parameters freely. */
function normaliseForMatch(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = decodeURIComponent(u.pathname).toLowerCase().replace(/\/+$/, '');
    return host + path;
  } catch {
    return null;
  }
}

export function collectSearchResultUrls(content) {
  const found = new Set();
  const add = (u) => { const n = normaliseForMatch(u); if (n) found.add(n); };
  for (const block of content || []) {
    if (block && block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) if (r && r.url) add(r.url);
    }
    if (block && block.type === 'text' && Array.isArray(block.citations)) {
      for (const c of block.citations) if (c && c.url) add(c.url);
    }
  }
  return found;
}

function parseItemArray(text) {
  let raw = String(text || '').replace(/```json|```/g, '').trim();
  if (!raw.startsWith('[')) {
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return null;
    raw = m[0];
  }
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/* Returns the text to send back: the same JSON array, minus any product
   whose link wasn't returned by a search. If the reply can't be read as a
   list at all, it's passed through untouched and the browser handles it as
   before. */
export function groundResults(resultText, content) {
  const items = parseItemArray(resultText);
  if (!items) return { text: resultText, kept: null, dropped: [] };
  const known = collectSearchResultUrls(content);
  const kept = [], dropped = [];
  for (const item of items) {
    const n = item && normaliseForMatch(item.url);
    if (n && known.has(n)) kept.push(item);
    else dropped.push(item && item.url);
  }
  return { text: JSON.stringify(kept), kept: kept.length, dropped };
}

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

/* ── Is this page actually the product? ──────────────────────────────────
   Added 26 Nov 2026. The old check only asked "does the page load?", and both
   bad links found in testing loaded perfectly: one was the wrong product, the
   other a category listing. So when the browser sends the product's name
   along with its link, we read the page and ask two more questions:

     1. Does the page title match the product name? A Nordstrom page titled
        "Play Mat with Arch" is not a "Linen Resort Short".
     2. Is it a product page at all? Retailers mark product pages for Google
        Shopping (schema.org "Product" data, or og:type "product"); listing
        pages don't carry that. A page with no product marker whose address
        also looks like a category ("/clothing/beachwear/beach-dresses") is
        rejected.

   When we can't tell — the retailer blocked our request, served a "checking
   your browser" page, had no title, or timed out — the link is KEPT. Blocking
   is common and says nothing about the link, and the job here is to remove
   links we know are wrong, not to throw away good ones on a hunch. */

const CHECK_BYTES = 300 * 1024;   // enough to cover the <head> and most structured data

// Pages a retailer shows instead of the real one when it suspects a bot.
const BLOCK_PAGE_TITLES = /access denied|just a moment|attention required|are you a robot|captcha|pardon our interruption|request blocked|security check|forbidden|bot detection|please verify|one more step/i;

// Words that say nothing about WHICH product it is.
const NAME_STOPWORDS = new Set([
  'the','and','with','for','by','of','in','a','an','to','on','at','from','new',
  'women','womens','woman','men','mens','man','unisex','ladies','size','sizes',
  'shop','buy','online','official','store','sale','free','shipping','us','uk','en'
]);

function stemWord(w) {
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function nameTokens(text) {
  return String(text || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(w => w.length >= 2 && !NAME_STOPWORDS.has(w))
    .map(stemWord);
}

/* How well the product name matches the page title. A token counts as found
   if it appears in the title as a word, or inside a run-together title word
   ("minidress" vs "mini dress"). Passing needs two matching words, or half
   the name for very short names. Deliberately generous: product names on
   retailer pages are often worded differently from the AI's version. */
export function titleMatches(productName, pageTitle) {
  const want = [...new Set(nameTokens(productName))];
  if (!want.length) return true;                 // nothing to compare
  const have = nameTokens(pageTitle);
  if (!have.length) return true;                 // no title — can't judge
  const haveSet = new Set(have);
  const joined = have.join('');
  const matched = want.filter(w => haveSet.has(w) || (w.length >= 4 && joined.includes(w))).length;
  return matched >= 2 || matched / want.length >= 0.5;
}

export function extractPageFacts(html) {
  const pick = (re) => { const m = html.match(re); return m ? decodeEntities(m[1]).trim() : ''; };
  const title = pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const ogTitle = pick(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i)
               || pick(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i);
  const ogType = pick(/<meta[^>]+property=["']og:type["'][^>]*content=["']([^"']*)["']/i)
              || pick(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:type["']/i);
  // Listing pages ALSO carry "Product" data — one entry per item shown (a
  // Mytheresa listing tested on 26 Nov had 60, inside an "ItemList"), so the
  // marker only means "a product page" when it appears a few times at most
  // and there's no list wrapper around it.
  const productCount = (html.match(/"@type"\s*:\s*\[?\s*"(?:https?:\/\/schema\.org\/)?Product"/gi) || []).length;
  const hasList = /"@type"\s*:\s*\[?\s*"(?:https?:\/\/schema\.org\/)?(ItemList|CollectionPage|OfferCatalog|SearchResultsPage)"/i.test(html);
  const isListing = hasList || productCount >= 4;
  const isProduct = (!isListing && productCount >= 1)
                 || /product/i.test(ogType)
                 || /itemtype=["']https?:\/\/schema\.org\/Product["']/i.test(html);
  // Stock, from the product's structured data: one "availability" per offer,
  // usually one offer per size. Sold out only when NO offer is buyable — one
  // sold-out size on an otherwise available product must not sink it.
  const avail = (html.match(/"availability"\s*:\s*"[^"]*"/gi) || []).map(a => a.toLowerCase());
  const buyable = avail.filter(a => /instock|limitedavailability|preorder|presale|backorder|onlineonly|instoreonly/.test(a)).length;
  const soldOut = avail.filter(a => /outofstock|soldout|discontinued/.test(a)).length;
  const isSoldOut = !isListing && soldOut > 0 && buyable === 0;
  return { title, ogTitle, isProduct, isListing, isSoldOut };
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/* A product address almost always carries an ID number or a product marker
   ("/product/", "/p/", "/dp/", ".html" with an ID…). One with neither is
   probably a listing. Only used together with the missing product marker,
   never on its own. */
export function looksLikeCategoryUrl(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (/\d{4,}/.test(p)) return false;
    if (/\/(products?|p|dp|item|items|pd|prd|buy|style)\//.test(p)) return false;
    return true;
  } catch {
    return false;
  }
}

async function readCapped(response, maxBytes) {
  if (!response.body || !response.body.getReader) return (await response.text()).slice(0, maxBytes);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    try { reader.cancel(); } catch {}
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks.map(c => Buffer.from(c))).subarray(0, maxBytes));
}

/* Full check for a link that came with a product name. Returns
   { url, alive, reason } — reason is only for the logs. */
async function checkProductPage(url, name) {
  if (!isCheckableUrl(url)) return { url, alive: false, reason: 'bad url' };
  let r;
  try {
    r = await fetchWithTimeout(url, 'GET');
  } catch {
    return { url, alive: true, reason: 'unreachable — kept', blocked: true };
  }
  if (r.status === 404 || r.status === 410) return { url, alive: false, reason: 'HTTP ' + r.status };
  if (r.status >= 400) return { url, alive: true, reason: 'HTTP ' + r.status + ' (likely blocked) — kept', blocked: true };
  if (!(r.headers.get('content-type') || '').includes('text/html')) return { url, alive: true, reason: 'not html — kept' };

  let html = '';
  try { html = await readCapped(r, CHECK_BYTES); } catch { return { url, alive: true, reason: 'unreadable — kept' }; }
  const lower = html.toLowerCase();
  const facts = extractPageFacts(html);
  const titleText = (facts.title + ' ' + facts.ogTitle).trim();

  if (BLOCK_PAGE_TITLES.test(titleText)) return { url, alive: true, reason: 'bot check — kept', blocked: true };

  if (DEAD_PAGE_PHRASES.some(p => lower.slice(0, 6000).includes(p))) {
    return { url, alive: false, reason: 'not-found page' };
  }
  // Landed on a homepage or top-level page instead of the product. (A move to
  // another host alone isn't counted — retailers redirect to regional sites
  // all the time; the title check below catches it if the product is wrong.)
  try {
    const o = new URL(url), f = new URL(r.url || url);
    const depth = (u) => u.pathname.split('/').filter(Boolean).length;
    if (depth(o) > 1 && depth(f) <= 1) return { url, alive: false, reason: 'redirected to ' + r.url };
  } catch {}
  if (titleText && !titleMatches(name, titleText)) {
    return { url, alive: false, reason: 'title "' + titleText.slice(0, 80) + '" ≠ "' + String(name).slice(0, 60) + '"' };
  }
  if (facts.isSoldOut) {
    return { url, alive: false, reason: 'sold out in every size' };
  }
  // A listing: the address has no product ID, and the page either describes
  // a list of products or doesn't describe a single one. (Product pages with
  // "you may also like" lists still pass — their addresses carry an ID.)
  if (looksLikeCategoryUrl(r.url || url) && (facts.isListing || !facts.isProduct)) {
    return { url, alive: false, reason: 'listing page, not a product' };
  }
  return { url, alive: true, reason: 'ok' };
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
    const names = Array.isArray(req.body.names) ? req.body.names : null;
    // Cap the batch so this can't be turned into a bulk scanning tool.
    const urls = submitted.slice(0, MAX_URLS_PER_CHECK);
    // With product names (the current frontend), read each page and check
    // it's really that product. Without them (an older cached frontend),
    // fall back to the original "does it load?" check.
    const results = await Promise.all(urls.map((u, i) =>
      names && typeof names[i] === 'string' && names[i] ? checkProductPage(u, names[i]) : checkUrl(u)));
    // One line per check, every time — so a quiet log means "all fine", not
    // "nobody looked". "blockedKept" counts pages the retailer wouldn't show
    // us, which were kept unchecked; if that number is high for a retailer,
    // the title and stock checks can't help there.
    const rejected = results.filter(x => !x.alive);
    const blocked = results.filter(x => x.blocked);
    const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return '?'; } };
    console.log('[LINKS] checked=' + results.length + ' ok=' + (results.length - rejected.length - blocked.length) +
      ' rejected=' + rejected.length + ' blockedKept=' + blocked.length +
      (blocked.length ? ' blockedBy=' + [...new Set(blocked.map(x => hostOf(x.url)))].join(',') : '') +
      (names ? '' : ' (no names sent — old check)') +
      (rejected.length ? ' | ' + rejected.map(x => x.url + ' (' + (x.reason || 'dead') + ')').join(' | ').slice(0, 1500) : ''));
    return res.status(200).json({ results: results.map(({ url, alive }) => ({ url, alive })) });
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
  const isGuide = resolvedMode === 'guide';

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
- VARIETY: use at least 4 different retailers, and never more than 2 items from the same retailer. This still applies when the user is petite, tall or pregnant — several of the stores above have petite, tall or maternity ranges, so spread across them rather than filling the list from one.
- Never recommend a retailer that has closed down. Do not use Matches / MatchesFashion — that business went into administration and its website closed.
- If you are not confident a product URL is live and correct, do not include that product — find another one instead.
- Every "url" is automatically compared against the pages your web searches actually returned. Any url that did not appear in your search results is discarded before the user sees it, so never construct, guess, shorten or edit a url — copy it exactly from a search result.
- Search in a way that returns individual product pages, not listings: include the brand, the product's name and the retailer in your query (e.g. "Isabel Marant Freya silk minidress Mytheresa").
- The "name" must be the product's real name as the retailer shows it on that page, because the page title is checked against it.

IMAGES:
- The "imageUrl" must be a direct CDN image URL ending in .jpg, .jpeg, .png, or .webp. No redirect URLs, no tracking URLs.

Respond with a raw JSON array only. No markdown, no preamble, no explanation.`;
  } else if (isGuide) {
    // The shopping guide is the longest reply this endpoint produces: nine
    // fields, around thirty separate items. It borrowed the fit check's 1500
    // tokens at first, which usually fit but left no headroom — and because
    // a truncated reply is turned into a hard error below, running over means
    // the whole guide fails rather than arriving slightly short. 2000 gives
    // comfortable room. Still no web search, so it stays cheap.
    requestBody.max_tokens = 2000;
    requestBody.system = 'You are a warm, experienced personal stylist writing a concise reference guide for one client to use while shopping in a physical shop. It is read one-handed on a phone, so respect the word caps in the prompt — but never pad to reach one, and never drop the reason a garment works in order to meet one. Be specific and committal rather than hedging. You must respond with valid JSON only — no preamble, no explanation, no markdown, no code fences. Your entire response must be a single JSON object starting with { and ending with }. Never criticise the client or imply a flaw in their body; describe only what garments do for their proportions.';
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

    // Log before anything else can return early — a reply that got truncated
    // still cost money, and those are exactly the calls worth seeing.
    logCost(resolvedMode, data.usage);

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

    // Product searches: keep only products whose link a search actually
    // returned. See groundResults() above.
    if (isOutfitSearch) {
      const g = groundResults(result, data.content);
      if (g.kept !== null) {
        console.log('[GROUND] kept=' + g.kept + ' dropped=' + g.dropped.length +
          (g.dropped.length ? ' invented=' + g.dropped.slice(0, 5).join(' ') : ''));
      }
      return res.status(200).json({ result: g.text });
    }

    return res.status(200).json({ result });

  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
