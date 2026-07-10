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

  const prompt = `You are a professional tire technician scanner. Analyze the attached image of a tire's rubber sidewall. 
Extract the tire specifications embossed directly into the black rubber. The text can be dusty, dirty, or low-contrast, so scan very carefully.
Return a clean JSON object with the following fields:
{
  "product_type": "tire",
  "brand": string (e.g. "Michelin", capitalized),
  "model": string (e.g. "Defender LTX", capitalized),
  "size": string (e.g. "275/65R18" or "35x12.50R20"),
  "load_index": string (e.g. "116"),
  "speed_rating": string (e.g. "T" or "H"),
  "load_range": string (e.g. "E" or "SL"),
  "xl_designation": string ("Yes" if Extra Load / XL is marked, otherwise "No"),
  "season": string ("Winter", "Summer", "All-Season", or "All-Terrain"),
  "has_3pmsf": boolean (true if the three-peak mountain snowflake symbol is embossed on the sidewall),
  "winter_approved": boolean (true if dedicated winter tire OR has_3pmsf is true),
  "ply_rating": string (look for "PLY RATING" or load range plies like "10-ply", "12-ply", "8PR", otherwise "N/A"),
  "dot_code": string (look for the DOT code printed on the sidewall, usually starts with "DOT" followed by 10-12 characters, e.g. "DOT 4B12 1224", otherwise "N/A"),
  "utqg": string (look for UTQG Treadwear/Traction/Temperature embossed text like "TREADWEAR 500 TRACTION A TEMPERATURE A", e.g. "500 A A", otherwise "N/A"),
  "extra_details": string (any secondary information like max load, max pressure, or tubeless designations, or empty string),
  "description": string (e.g. "Michelin Defender LTX 275/65R18 116T E-Load 10-Ply Tire")
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
    return res.status(500).json({ error: 'Failed to process tire sidewall. Please try again.' });
  }
}
