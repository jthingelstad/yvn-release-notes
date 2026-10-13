/** Account emails preserve the existing proof, code lifetime and deletion copy.
 * They carry no List-Unsubscribe and are metered as account mail by the caller. */
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { APP, FONT, MONO, INK, INK_2, BLUE, PAPER, escape } from './compose.ts';
export const signinSubject = (code: string) => `${code} is your Release Notes code`;

export function signinText(link: string, code: string): string {
  return `Sign in to Release Notes:

${link}

Or type this code where you asked: ${code}

The link and the code work once, for 15 minutes. If you didn't ask, you can
ignore this email: nothing happens without the link or the code.

This comes from the same address as the daily email. Adding it to your
contacts keeps both out of junk.
`;
}

export function signinHtml(link: string, code: string): string {
  const p = `margin:0 0 18px;font:16px/1.55 ${FONT};color:${INK_2}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>Sign in to Release Notes</title></head>
<body style="margin:0;padding:0;background:${PAPER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}"><tr><td style="padding:32px 20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto"><tr><td>
<p style="margin:0 0 24px;font:800 18px/1.3 ${FONT};color:${INK}">Release Notes</p>
<p style="margin:0 0 18px;font:800 26px/1.2 ${FONT};color:${INK}"><a href="${escape(link)}" style="color:${BLUE}">Sign in to Release Notes</a></p>
<p style="${p}">Or type this code where you asked:</p>
<p style="margin:0 0 24px;font:700 30px/1 ${MONO};letter-spacing:.2em;color:${BLUE}">${escape(code)}</p>
<p style="${p}">The link and the code work once, for 15 minutes. If you didn&rsquo;t ask, you can ignore this email: nothing happens without the link or the code.</p>
<p style="margin:0;font:14px/1.55 ${FONT};color:${INK_2}">This comes from the same address as the daily email. Adding it to your contacts keeps both out of junk.</p>
</td></tr></table>
</td></tr></table>
</body></html>
`;
}

export function deleteText(code: string, settings = APP + '/settings/'): string {
  return `Someone signed in to your Release Notes asked to delete the account:
every note, the emails behind them, and your settings.

To go ahead, type this code on the page that asked: ${code}

It works once, for 15 minutes. If you didn't ask, ignore this email and
nothing is deleted. To keep a copy first, export from ${settings}
`;
}

export function deleteHtml(code: string, settings = APP + '/settings/'): string {
  const p = `margin:0 0 18px;font:16px/1.55 ${FONT};color:${INK_2}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><title>Delete your Release Notes</title></head>
<body style="margin:0;padding:0;background:${PAPER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER}"><tr><td style="padding:32px 20px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto"><tr><td>
<p style="margin:0 0 24px;font:800 18px/1.3 ${FONT};color:${INK}">Release Notes</p>
<p style="margin:0 0 18px;font:800 26px/1.2 ${FONT};color:${INK}">Delete your Release Notes?</p>
<p style="${p}">Someone signed in to your account asked to delete it: every note, the emails behind them, and your settings. To go ahead, type this code on the page that asked:</p>
<p style="margin:0 0 24px;font:700 30px/1 ${MONO};letter-spacing:.2em;color:${BLUE}">${escape(code)}</p>
<p style="${p}">It works once, for 15 minutes. If you didn&rsquo;t ask, ignore this email and nothing is deleted.</p>
<p style="margin:0;font:14px/1.55 ${FONT};color:${INK_2}">To keep a copy first, <a href="${escape(settings)}" style="color:${BLUE}">export from settings</a>.</p>
</td></tr></table>
</td></tr></table>
</body></html>
`;
}

const transport = nodemailer.createTransport({
  streamTransport: true,
  buffer: true,
  newline: 'unix',
  disableFileAccess: true,
  disableUrlAccess: true
});
interface AccountEmail {
  to: string;
  fromAddr: string;
  code: string;
}
async function compose(o: AccountEmail, subject: string, text: string, html: string): Promise<Buffer> {
  const sent = await transport.sendMail({
    from: { name: 'Release Notes', address: o.fromAddr },
    to: o.to,
    subject,
    messageId: `<${randomUUID()}@${o.fromAddr.split('@')[1]}>`,
    text,
    html,
    disableFileAccess: true,
    disableUrlAccess: true
  });
  if (!Buffer.isBuffer(sent.message)) throw new TypeError('Expected buffered MIME');
  return sent.message;
}
export const signinMessage = (o: AccountEmail & { link: string }): Promise<Buffer> =>
  compose(o, signinSubject(o.code), signinText(o.link, o.code), signinHtml(o.link, o.code));
export const deleteMessage = (o: AccountEmail): Promise<Buffer> =>
  compose(o, `${o.code} confirms deleting your Release Notes`, deleteText(o.code), deleteHtml(o.code));
