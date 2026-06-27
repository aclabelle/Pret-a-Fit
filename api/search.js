export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { prompt, imageBase64, imageMediaType } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: 'Missing prompt' });
  }

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

  // For outfit searches, attach the web_search tool
  // Quiz prompts always include 'quiz:true' flag or we detect by absence of retailer pattern
  const isOutfitSearch = typeof prompt === 'string' && prompt.includes('Fashion search engine');
  const requestBody = {
    model: 'claude-sonnet-4-6',
    max_tokens: 4000,
    messages: [{ role: 'user', content: messageContent }]
  };

  if (isOutfitSearch) {
    requestBody.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
    requestBody.max_tokens = 4000;
  } else {
    // Quiz calls need much less — keep it fast and cheap
    requestBody.max_tokens = 500;
  }

  // Only send the beta header for outfit searches that use web_search
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

    // Extract text from the response content blocks
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
