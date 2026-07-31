const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email } = req.body;

  // Basic validation
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    await resend.emails.send({
      from: 'Prêt-à-Fit Waitlist <contact@pret-a-fit.com>',
      to: 'support@pret-a-fit.com',
      replyTo: email,
      subject: `Prêt-à-Fit waitlist: ${name}`,
      text: `New waitlist signup\n\nName: ${name}\nEmail: ${email}`,
      html: `
        <div style="font-family:Georgia,serif;max-width:560px;color:#1C1712;">
          <p style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#8B6F47;margin-bottom:1.5rem;">Prêt-à-Fit — New Waitlist Signup</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:1.5rem;">
            <tr><td style="padding:8px 0;border-bottom:0.5px solid #EDE6D6;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#C4A882;width:100px;">Name</td><td style="padding:8px 0;border-bottom:0.5px solid #EDE6D6;font-size:14px;">${name}</td></tr>
            <tr><td style="padding:8px 0;border-bottom:0.5px solid #EDE6D6;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#C4A882;">Email</td><td style="padding:8px 0;border-bottom:0.5px solid #EDE6D6;font-size:14px;"><a href="mailto:${email}" style="color:#8B6F47;text-decoration:none;">${email}</a></td></tr>
          </table>
        </div>
      `
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Resend error:', err);
    return res.status(500).json({ error: 'Failed to join the waitlist. Please try again.' });
  }
};
