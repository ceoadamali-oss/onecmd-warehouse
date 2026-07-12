import { requireStaffAuth } from './_auth.js';
import { getOpenAIKey } from './_openaiKey.js';

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!await requireStaffAuth(req, res)) return;

  const { base64Image } = req.body;
  if (!base64Image) {
    return res.status(400).json({ error: 'Missing base64Image' });
  }

  const apiKey = getOpenAIKey();

  if (!apiKey) {
    return res.status(500).json({ error: 'OpenAI API key configuration error on server.' });
  }

  const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');

  const prompt = `Analyze the attached image showing stacks of stored tires in a warehouse.
Estimate the quantity of tires visible or partially visible in this stack, taking into account depth and columns.
Return a clean JSON object with the following fields:
{
  "estimated_min": number (the lower bound of your estimate, integer),
  "estimated_max": number (the upper bound of your estimate, integer),
  "confidence_score": number (confidence percentage from 0 to 100, e.g. 94),
  "reasoning": string (brief explanation of how you counted the stacks and calculated the range)
}
Do not return any markdown formatting or extra text. Just the JSON object.`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/jpeg;base64,${base64Data}`
                }
              }
            ]
          }
        ],
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`OpenAI API returned status ${response.status}: ${errText}`);
      return res.status(401).json({ error: 'AI analysis failed. Please verify API configuration.' });
    }

    const data = await response.json();
    const resultText = data.choices?.[0]?.message?.content;
    if (!resultText) {
      return res.status(500).json({ error: 'Empty response from OpenAI' });
    }

    const parsed = JSON.parse(resultText);
    return res.status(200).json(parsed);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to process tire stack image. Please try again.' });
  }
}
