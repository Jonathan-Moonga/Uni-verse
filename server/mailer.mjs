// Outgoing email for invitations (and, locally, verification and reset links).
// Every message is recorded in server_private.outbox; with RESEND_API_KEY set it is
// also delivered through Resend. Supabase Auth sends its own confirmation emails.

export function createMailer({ resendApiKey = "", from = "", log = true, fetchImpl = fetch } = {}) {
  async function deliver({ to, subject, body, link }) {
    if (!resendApiKey || !from) return null;
    const html = `<p>${escapeHtml(body)}</p>${link ? `<p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>` : ""}`;
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${resendApiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text: link ? `${body}\n\n${link}` : body })
    });
    if (!response.ok) {
      console.error(`Email to ${to} failed: ${response.status} ${await response.text().catch(() => "")}`);
      return null;
    }
    return "resend";
  }

  return {
    // `tx` is a transaction handle with .query(); the outbox row commits with it.
    async send(tx, message) {
      const via = await deliver(message);
      await tx.query(
        "insert into server_private.outbox (to_email, subject, body, link, delivered_via) values ($1, $2, $3, $4, $5)",
        [message.to, message.subject, message.body, message.link ?? null, via]
      );
      if (log) console.log(`✉  ${message.to} — ${message.subject}${via ? " (sent)" : ""}${message.link ? `\n   ${message.link}` : ""}`);
      return via;
    }
  };
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
