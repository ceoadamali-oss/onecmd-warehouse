const OPENAI_API_KEY = import.meta.env.VITE_OPENAI_API_KEY || '';

export interface TireStickerData {
  brand: string;
  model: string;
  size: string;
  load_index: string;
  speed_rating: string;
  load_range: string;
  xl_designation: string;
  season: string;
  /** True if the three-peak mountain snowflake (3PMSF) symbol is visible on the sticker. */
  has_3pmsf: boolean;
  /** True for dedicated winter tires OR 3PMSF-rated all-weather / A/T tires. */
  winter_approved: boolean;
  description: string;
}

export interface StackEstimateData {
  estimated_min: number;
  estimated_max: number;
  confidence_score: number;
  reasoning: string;
}

/**
 * Calls OpenAI GPT-4o-mini Vision to extract specs from a tire label image.
 */
export async function parseTireSticker(base64Image: string): Promise<TireStickerData> {
  if (!OPENAI_API_KEY) {
    throw new Error('OpenAI API Key is missing. Please check your .env file.');
  }

  // Remove data:image/...;base64, prefix if present
  const base64Data = base64Image.replace(/^data:image\/\w+;base64,/, '');

  const prompt = `You are a professional tire inventory receiving scanner. Extract the tire specifications from this tire sticker or label image.
Return a clean JSON object with the following fields:
{
  "brand": string (e.g., "Centara", capitalized),
  "model": string (e.g., "Snow Cutter", capitalized),
  "size": string (e.g., "205/55R16" or "33x12.50R20"),
  "load_index": string (e.g., "91" or "94"),
  "speed_rating": string (e.g., "T" or "H"),
  "load_range": string (e.g., "SL" or "XL"),
  "xl_designation": string ("Yes" if marked XL/Extra Load, otherwise "No"),
  "season": string ("Winter", "Summer", "All-Season", or "All-Terrain"),
  "has_3pmsf": boolean (true if the three-peak mountain snowflake symbol is visible on the sticker),
  "winter_approved": boolean (true if dedicated winter tire OR has_3pmsf is true),
  "description": string (e.g., "Centara Snow Cutter 205/55R16 91T Winter Tire")
}
Do not return any markdown formatting or extra text. Just the JSON object.`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
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
    throw new Error(`OpenAI API Error: ${response.statusText} - ${errText}`);
  }

  const result = await response.json();
  const jsonString = result.choices?.[0]?.message?.content;
  if (!jsonString) {
    throw new Error('Failed to retrieve content from OpenAI response.');
  }

  return JSON.parse(jsonString) as TireStickerData;
}

/** Lines/brands that are always 3PMSF winter-approved at ATK when AI misses the symbol. */
export function inferWinterApprovedFromCatalog(brand: string, model: string, parsed?: Partial<TireStickerData>): boolean {
  if (parsed?.winter_approved || parsed?.has_3pmsf) return true;
  if (parsed?.season === 'Winter') return true;

  const haystack = `${brand} ${model}`.toLowerCase();
  const knownLines = ['veteran', 'battlefield', 'aquishi', 'aqishi', 'snow cutter', 'ice master', 'winter'];
  return knownLines.some((token) => haystack.includes(token));
}

/**
 * Calls OpenAI GPT-4o-mini Vision to estimate the count of stacked tires.
 */
export async function estimateStackCount(base64Image: string): Promise<StackEstimateData> {
  if (!OPENAI_API_KEY) {
    throw new Error('OpenAI API Key is missing. Please check your .env file.');
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

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
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
    throw new Error(`OpenAI API Error: ${response.statusText} - ${errText}`);
  }

  const result = await response.json();
  const jsonString = result.choices?.[0]?.message?.content;
  if (!jsonString) {
    throw new Error('Failed to retrieve content from OpenAI response.');
  }

  return JSON.parse(jsonString) as StackEstimateData;
}
