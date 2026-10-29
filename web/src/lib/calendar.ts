// Subscribe's address. Apple's Calendar takes webcal: itself; Android has no
// app for webcal:, so the tap did nothing there, and it goes to Google
// Calendar's "add by URL" page instead, which takes the same webcal: address.
export function subscribeHref(calendar: string, ua = navigator.userAgent): string {
  const webcal = calendar.replace(/^https?:/, 'webcal:');
  return /Android/i.test(ua) ? 'https://calendar.google.com/calendar/render?cid=' + encodeURIComponent(webcal) : webcal;
}
