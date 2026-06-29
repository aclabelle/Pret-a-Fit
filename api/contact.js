const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

module.exports = async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { name, email, subject, message } = req.body;

  // Basic validation
  if (!name || !email || !message) {
    return res.status(400).json({ error: 'Name, email and message are required.' });
  }

  try {
    await resend.emails.send({
      from: 'Prêt-à-Fit Contact Form <contact@pret-a-fit.com>',
      to: 'support@pret-a-fit.com',
      replyTo: email,
      subject: `Prêt-à-Fit: ${subject || 'Message from ' + name}`,
      text: `Name: ${name}\nEmail: ${email}\nSubject: ${subject || '(none)'}\n\n${message}`,
      html: `
        <div style="font-family:Georgia,serif;max-width:560px;color:#1C1712;">
          <p style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:#8B6F47;margin-bottom:1.5rem;">Prêt-à-Fit — Contact Form</p>
          <table style="width:100%;border-collapse:collapse;margin-bottom:1.5rem;">
            <tr><td style="padding:8px 0;border-bottom:0.5px solid #EDE6D6;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#C4A882;width:100px;">From</td><td style="padding:8px 0;border-bottom:0.5px solid #EDE6D6;font-size:14px;">${name}</td></tr>
            <tr><td style="padding:8px 0;border-bottom:0.5px solid #EDE6D6;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#C4A882;">Email</td><td style="padding:8px 0;border-bottom:0.5px solid #EDE6D6;font-size:14px;"><a href="mailto:${email}" style="color:#8B6F47;text-decoration:none;">${email}</a></td></tr>
            <tr><td style="padding:8px 0;border-bottom:0.5px solid #EDE6D6;font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#C4A882;">Subject</td><td style="padding:8px 0;border-bottom:0.5px solid #EDE6D6;font-size:14px;">${subject || '(none selected)'}</td></tr>
          </table>
          <p style="font-size:14px;line-height:1.7;white-space:pre-wrap;">${message}</p>
        </div>
      `
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Resend error:', err);
    return res.status(500).json({ error: 'Failed to send message. Please try again.' });
  }
};
