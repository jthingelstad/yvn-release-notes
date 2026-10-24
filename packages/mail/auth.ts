/** Account emails preserve the existing proof, code lifetime and deletion copy.
 * They carry no List-Unsubscribe and are metered as account mail by the caller. */
import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { APP, BLUE, FONT, INK_2, ACCOUNT_P, accountHtml, action, codeHtml, escape } from './compose.ts';
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
  return accountHtml(
    'Sign in to Release Notes',
    'Sign in to Release Notes',
    `<p style="margin:0 0 28px;">${action(escape(link), 'Sign in', 18)}</p>
${codeHtml('Or type this code where you asked', code)}<p class="ink-2" style="${ACCOUNT_P}">The link and the code work once, for 15 minutes. If you didn&rsquo;t ask, you can ignore this email: nothing happens without the link or the code.</p>
<p class="ink-2" style="margin:0;font-family:${FONT};font-size:14px;line-height:1.55;color:${INK_2};">This comes from the same address as the daily email. Adding it to your contacts keeps both out of junk.</p>
`
  );
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
  return accountHtml(
    'Delete your Release Notes',
    'Delete your Release Notes?',
    `<p class="ink-2" style="${ACCOUNT_P}">Someone signed in to your account asked to delete it: every note, the emails behind them, and your settings. To go ahead, type this code on the page that asked.</p>
${codeHtml('Your code', code)}<p class="ink-2" style="${ACCOUNT_P}">It works once, for 15 minutes. If you didn&rsquo;t ask, ignore this email and nothing is deleted.</p>
<p class="ink-2" style="margin:0;font-family:${FONT};font-size:14px;line-height:1.55;color:${INK_2};">To keep a copy first, <a class="link" href="${escape(settings)}" style="color:${BLUE};">export from settings</a>.</p>
`
  );
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
