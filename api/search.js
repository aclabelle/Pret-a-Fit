export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, imageBase64, imageMediaType } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

  const isOutfitSearch = typeof prompt === 'string' && prompt.includes('Fashion search engine');

  // Build the message content — text only, or text + image for photo analysis
  let messageContent;
  if (imageBase64) {
    messageContent = [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: imageMediaType || 'image/jpeg',
          data: imageBase64
        }
      },
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
  } else {
    // Quiz calls: enforce strict JSON-only output via system prompt
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
