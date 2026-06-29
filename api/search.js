export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, imageBase64, imageMediaType, image2Base64, image2MediaType, validateUrls } = req.body;

  // ── URL validation mode ──────────────────────────────────────────────────
  // The frontend sends a list of URLs and we check which ones are alive.
  if (validateUrls) {
    const urls = req.body.urls || [];
    const results = await Promise.all(
      urls.map(async (url) => {
        try {
          const r = await fetch(url, {
            method: 'HEAD',
            redirect: 'follow',
            signal: AbortSignal.timeout(6000),
            headers: {
              // Mimic a real browser so retailers don't block the request
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,*/*'
            }
          });
          // 200–399 = live. 404/410 = dead. 403/429/5xx = uncertain, keep it.
          const alive = r.status < 400 || (r.status !== 404 && r.status !== 410);
          return { url, alive };
        } catch {
          // Network timeout or DNS failure — treat as uncertain, keep it
          return { url, alive: true };
        }
      })
    );
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
