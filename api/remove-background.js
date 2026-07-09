import { Client } from "@gradio/client";

// Vercel serverless function to perform background removal using BRIA RMBG-1.4
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const { base64Image } = req.body;
  if (!base64Image) {
    return res.status(400).json({ error: 'Missing base64Image parameter' });
  }

  try {
    const cleanBase64 = base64Image.replace(/^data:image\/\w+;base64,/, '');
    const imageBuffer = Buffer.from(cleanBase64, 'base64');

    // 1. Try Hugging Face Serverless Inference API (Router) first if HF_TOKEN is set
    const hfToken = process.env.HF_TOKEN || process.env.VITE_HF_TOKEN;
    if (hfToken) {
      console.log("Using Hugging Face Inference API with configured HF_TOKEN...");
      try {
        const hfResponse = await fetch("https://router.huggingface.co/hf-inference/models/briaai/RMBG-1.4", {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "Authorization": `Bearer ${hfToken}`
          },
          body: imageBuffer
        });

        if (hfResponse.ok) {
          const arrayBuffer = await hfResponse.arrayBuffer();
          const pngBuffer = Buffer.from(arrayBuffer);
          const resultBase64 = `data:image/png;base64,${pngBuffer.toString('base64')}`;
          return res.status(200).json({ transparentImage: resultBase64, source: 'hf-inference-api' });
        } else {
          console.warn(`HF Inference API failed with status ${hfResponse.status}. Falling back to Gradio Space...`);
        }
      } catch (hfErr) {
        console.warn("HF Inference API error. Falling back to Gradio Space:", hfErr.message);
      }
    }

    // 2. Fallback: Connect to public Gradio Space 'briaai/BRIA-RMBG-1.4'
    console.log("Connecting to Gradio Space briaai/BRIA-RMBG-1.4...");
    const client = await Client.connect("briaai/BRIA-RMBG-1.4");
    
    // Gradio predicts using the base64 data URL
    const predictResult = await client.predict("/predict", {
      image: base64Image
    });

    if (predictResult.data && predictResult.data[0]) {
      const outputObj = predictResult.data[0];
      const fileUrl = outputObj.url;

      if (!fileUrl) {
        throw new Error("Gradio prediction returned empty output URL");
      }

      console.log("Downloading result from Gradio space:", fileUrl);
      const downloadResponse = await fetch(fileUrl);
      if (!downloadResponse.ok) {
        throw new Error(`Failed to download processed image from Gradio: ${downloadResponse.statusText}`);
      }

      const fileArrayBuffer = await downloadResponse.arrayBuffer();
      const pngBuffer = Buffer.from(fileArrayBuffer);
      const resultBase64 = `data:image/png;base64,${pngBuffer.toString('base64')}`;
      
      return res.status(200).json({ transparentImage: resultBase64, source: 'gradio-space-fallback' });
    } else {
      throw new Error("No data returned in Gradio predict output");
    }
  } catch (error) {
    console.error("Background removal processing failed:", error);
    return res.status(500).json({ error: `Background removal failed: ${error.message}` });
  }
}
