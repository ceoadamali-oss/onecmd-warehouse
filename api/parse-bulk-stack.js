import { requireStaffAuth } from './_auth.js';

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

  if (!requireStaffAuth(req, res)) return;

  const { base64Image } = req.body;
  if (!base64Image) {
    return res.status(400).json({ error: 'Missing base64Image' });
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'OpenAI API key configuration error on server.' });
  }

  const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');

  const prompt = `You are a professional tire and wheel inventory receiving scanner designed to do bulk scanning.
Analyze this photo containing a stack, row, or group of multiple tires or wheels showing their labels/stickers or sidewall markings.
Find every individual product sticker or distinct sidewall marking visible in this image. For each one, extract the specifications.
Return a clean JSON object containing an array of items:
{
  "items": [
    {
      "product_type": "tire" or "wheel",
      "brand": string (capitalized brand, e.g., "Centara" or "Commander"),
      "model": string (capitalized model, e.g., "Snow Cutter" or "H709"),
      "size": string (e.g. "205/55R16" or "20x10"),
      
      // IF TIRE:
      "load_index": string (e.g., "91" or "94"),
      "speed_rating": string (e.g., "T" or "H"),
      "load_range": string (e.g., "SL" or "XL"),
      "xl_designation": string ("Yes" if marked XL/Extra Load, otherwise "No"),
      "season": string ("Winter", "Summer", "All-Season", or "All-Terrain"),
      "has_3pmsf": boolean (true if the three-peak mountain snowflake symbol is visible),
      "winter_approved": boolean (true if winter approved),
      "utqg": string (e.g., "420 A A", otherwise "N/A"),
      "ply_rating": string (e.g. "10-ply", otherwise "N/A"),
      "dot_code": string (the DOT marking if visible, e.g. "DOT 4B12 1224", otherwise "N/A"),
      
      // IF WHEEL:
      "bolt_pattern": string (e.g. "5x127/139.7" or "5x114.3"),
      "offset": string (e.g. "-19" or "45"),
      "center_bore": string (e.g. "87" or "73.1"),
      "finish": string (e.g. "Gloss Black Milled"),
      "part_number": string (e.g. "H709-201052119GBM"),
      
      "extra_details": string (any secondary visible info),
      "description": string (brief description of this item)
    }
  ]
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
    return res.status(500).json({ error: 'Failed to process bulk scan. Please try again.' });
  }
}
