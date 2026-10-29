// Subscribe's address, or null where no tap can subscribe. Apple's Calendar
// takes webcal: itself. Android has no app for webcal: (the tap did
// nothing), and Google Calendar adds a calendar from a URL only on the web
// from a computer, not in its Android app, so Android gets the steps instead.
export function subscribeHref(calendar: string, ua = navigator.userAgent): string | null {
  return /Android/i.test(ua) ? null : calendar.replace(/^https?:/, 'webcal:');
}
