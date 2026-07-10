import { requireStaffAuth } from './_auth.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!requireStaffAuth(req, res)) return;

  const { email, subject, html } = req.body;
  if (!email || !subject || !html) {
    return res.status(400).json({ error: 'Missing required parameters (email, subject, html)' });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.warn(`[API send-email] RESEND_API_KEY env is missing. Simulated email to: ${email}`);
    return res.status(200).json({ 
      success: true, 
      simulated: true, 
      message: `Simulated send to ${email} (RESEND_API_KEY not configured).` 
    });
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from: 'Atlantic Tire King <onboarding@resend.dev>',
        to: email,
        subject: subject,
        html: html
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Resend API returned status ${response.status}: ${errText}`);
    }

    const result = await response.json();
    return res.status(200).json({ success: true, messageId: result.id });
  } catch (error) {
    console.error('[API send-email] Failed to send email via Resend:', error);
    return res.status(500).json({ error: error.message });
  }
}
