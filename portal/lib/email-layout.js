function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function plainText(value) {
  return String(value ?? "").replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function renderEmailLayout(o, base) {
  const esc = escapeHtml;
  const warning = /Action needed|Reminder|Paused|Ending soon|Scheduled|Heads up/.test(o.chip || "");
  const palette = warning ? ["#fff3e0", "#815300", "#f2dfb9"] : ["#eaf3ff", "#235493", "#d5e5fa"];
  const chip = o.chip ? `<span style="display:inline-block;padding:7px 10px;border-radius:999px;background:${palette[0]};color:${palette[1]};border:1px solid ${palette[2]};font-size:12px;font-weight:700;white-space:nowrap">${esc(o.chip)}</span>` : "";
  const steps = (o.steps || []).map(s => typeof s === "string" ? { title: s, text: "" } : s);
  const rows = steps.map((s, i) => `<tr><td style="width:24px;vertical-align:top;padding:0 12px 18px 0;color:#777;font-size:13px">${i + 1}.</td><td style="padding:0 0 18px;font-size:14px;line-height:1.6;color:#555"><strong style="color:#222">${esc(s.title)}</strong>${s.text ? `<br>${esc(s.text)}` : ""}</td></tr>`).join("");
  const code = o.code ? `<div style="margin:26px 0 24px;padding:24px 0;border-top:1px solid #e5e5e5;border-bottom:1px solid #e5e5e5;text-align:center"><div style="font-size:12px;color:#666;margin-bottom:14px">${esc(o.codeLabel || "Your verification code")}</div><table role="presentation" align="center" style="margin:0 auto;border-collapse:separate;border-spacing:4px"><tr>${Array.from(String(o.code)).map(c => `<td width="36" height="50" style="width:36px;height:50px;border:1px solid #e6e6e6;background:#f4f4f4;border-radius:4px;text-align:center;font-size:28px;font-weight:700;font-family:Consolas,monospace;color:#1b1b1b">${esc(c)}</td>`).join("")}</tr></table><p style="margin:14px 0 0;font-size:12px;color:#686868">Enter in KiddieGPT${o.codeExpiry ? ` &middot; ${esc(o.codeExpiry)}` : ""}</p></div>` : "";
  const paragraphs = (o.paragraphs || []).map(p => `<p style="font-size:15px;line-height:1.65;color:#555;margin:0 0 14px">${p}</p>`).join("");
  const url = o.ctaUrl || base;
  const cta = o.ctaText ? `<table role="presentation" style="margin:10px 0 24px;border-collapse:separate"><tr><td bgcolor="#202020" style="background:#202020;border-radius:6px;text-align:center"><a href="${esc(url)}" style="display:inline-block;padding:14px 22px;color:#fff;text-decoration:none;font-size:14px;font-weight:700">${esc(o.ctaText)} &rarr;</a></td></tr></table>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title></head><body style="margin:0;background:#efefef;font-family:Arial,Helvetica,sans-serif;color:#202020">
<table role="presentation" width="100%" style="background:#efefef;border-collapse:collapse"><tr><td align="center" style="padding:24px 8px">
<table role="presentation" width="600" style="width:100%;max-width:600px;background:#fff;border:1px solid #dedede;border-radius:8px;border-spacing:0">
<tr><td style="padding:24px 20px;border-bottom:1px solid #ededed"><table role="presentation" width="100%" style="border-collapse:collapse"><tr><td style="vertical-align:middle;white-space:nowrap"><img src="${esc(base)}/webapp/assets/email-logo.png" width="36" height="36" alt="" style="vertical-align:middle;display:inline-block;border:0">&nbsp;<span style="font-size:18px;font-weight:700;color:#202020;vertical-align:middle">KiddieGPT</span></td><td align="right" style="padding-left:8px;vertical-align:middle">${chip}</td></tr></table></td></tr>
<tr><td style="padding:30px 24px"><p style="margin:0 0 12px;color:#707070;font-size:11px;font-weight:700">${esc(o.eyebrow || "KIDDIEGPT")}</p><h1 style="font-size:28px;line-height:1.25;color:#171717;margin:0 0 24px;font-weight:700">${esc(o.title)}</h1>
${o.greeting ? `<p style="font-size:15px;line-height:1.65;color:#252525;font-weight:600;margin:0 0 12px">${esc(o.greeting)}</p>` : ""}${paragraphs}${code}${rows ? `<table role="presentation" width="100%" style="border-collapse:collapse;margin:20px 0 8px">${rows}</table>` : ""}${cta}
${o.code ? `<p style="font-size:13px;color:#696969;line-height:1.6;margin:0 0 12px">Keep this code private. If you didn't request it, you can safely ignore this email.</p>` : ""}
${o.signoff ? `<p style="font-size:14px;line-height:1.65;color:#222;margin:26px 0 0">Here for every little breakthrough,<br><strong>The KiddieGPT Team</strong></p>` : ""}
</td></tr><tr><td style="padding:22px 24px;background:#fafafa;border-top:1px solid #ececec"><p style="font-size:12px;line-height:1.6;color:#6a6a6a;margin:0">Questions? We're here to help.<br><a href="mailto:support@kiddiegpt.com" style="color:#383838;text-decoration:underline">support@kiddiegpt.com</a></p></td></tr></table>
<p style="font-size:11px;color:#777;margin:16px 0 0">KiddieGPT &middot; A little help. A lot of possibility.</p></td></tr></table></body></html>`;
  const text = [o.title, o.greeting, ...(o.paragraphs || []).map(plainText),
    o.code ? `${o.codeLabel || "Your verification code"}: ${o.code}${o.codeExpiry ? `\n${o.codeExpiry}` : ""}` : "",
    ...steps.map((s, i) => `${i + 1}. ${s.title}${s.text ? `\n${s.text}` : ""}`),
    o.ctaText ? `${o.ctaText}: ${url}` : "", o.code ? "Keep this code private. If you didn't request it, ignore this email." : "",
    o.signoff ? "Here for every little breakthrough,\nThe KiddieGPT Team" : "", "Questions? support@kiddiegpt.com"]
    .filter(Boolean).join("\n\n");
  return { html, text };
}

module.exports = { renderEmailLayout };
