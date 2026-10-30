// What Release Notes does, as one list: each feature's head, its one line
// and the guide page that says the rest. The front page's tour
// (components/tour.tsx) draws the groups' features it shows, /features/
// draws every one, and /guide/ lists their guide pages (site-pages.ts), so
// the tour and the docs can't say different things. Every line is true of
// the product today; a number in one is checked against its constant by
// tests-node/site.test.ts, as the pages' are. No JSX, so the site's build
// and the server's tests read it as it is.

export interface Feature {
  /** Bold, ending in a full stop: "Upcoming." */
  head: string;
  /** One or two sentences, plain text. */
  line: string;
  /** The guide page that says the rest, like /guide/upcoming/. */
  guide: string;
  /** False for a feature /features/ lists and the front page's tour leaves out. */
  tour?: false;
}

export interface FeatureGroup {
  head: string;
  features: Feature[];
}

export const FEATURES: FeatureGroup[] = [
  {
    head: 'Write it however it comes',
    features: [
      {
        head: 'Reply, or write on the web.',
        line: 'Answer from any mail app, or write here, today or any day back to your birthday.',
        guide: '/guide/replying/'
      },
      {
        head: 'Photos, voice memos and PDFs.',
        line: 'Attach photos, voice memos and PDFs to a reply, or add them on the web. They stay with their day.',
        guide: '/guide/photos-and-voice/'
      },
      { head: 'An address of your own.', line: 'Mail a note any day, no reply needed.', guide: '/guide/address/' },
      {
        head: 'On your Home Screen.',
        line: 'Add it to your phone and it opens like an app.',
        guide: '/guide/start/'
      },
      {
        head: 'An iPhone app.',
        line: 'Changelog adds a note in two taps, with photos, a voice memo or where you are, or from Siri, a widget or the share sheet. It’s in testing on TestFlight.',
        guide: '/guide/changelog/',
        tour: false
      },
      {
        head: 'Your assistant, if you like.',
        line: 'Connect Claude or ChatGPT to read your notes, and to add to them only if you allow it.',
        guide: '/guide/agents/'
      },
      {
        head: 'Your own apps and scripts.',
        line: 'Make an API token, and a script, a shortcut or an app can add notes as you, with photos and where you were.',
        guide: '/guide/tokens/'
      }
    ]
  },
  {
    head: 'See it come back',
    features: [
      {
        head: 'Yesterday, confirmed.',
        line: 'Each morning shows what you sent the day before, so you know it all arrived.',
        guide: '/guide/the-email/'
      },
      {
        head: 'On this day.',
        line: 'What you wrote on this same day in every earlier release.',
        guide: '/guide/the-email/'
      },
      {
        head: 'A birthday closes the release.',
        line: 'The year just ended, summed up, with a page of its own.',
        guide: '/guide/the-email/'
      },
      {
        head: 'Streaks, counts and badges.',
        line: 'Quiet ones. Miss a day and nothing scolds you.',
        guide: '/guide/badges/'
      },
      {
        head: 'Weather and places.',
        line: 'Your days keep their weather. A note can keep exactly where it was, on your own map.',
        guide: '/guide/places-and-map/'
      },
      {
        head: 'Upcoming.',
        line: 'Birthdays, anniversaries and trips, remembered in the morning email and in your calendar.',
        guide: '/guide/upcoming/'
      }
    ]
  },
  {
    head: 'Find it, and keep it',
    features: [
      {
        head: 'Tags and search.',
        line: '#hashtags in any note, and search across every word. Turn it on, and what you said in a voice memo and what’s in a photo are found too.',
        guide: '/guide/tags-and-search/'
      },
      {
        head: 'A book of your days.',
        line: 'Any days you pick, set as a PDF with their photos, places and weather, to read or to print.',
        guide: '/guide/book/',
        tour: false
      },
      {
        head: 'Yours to take.',
        line: 'Export everything as a zip, files and all, or delete it, any time.',
        guide: '/guide/export/'
      }
    ]
  },
  {
    head: 'On your terms',
    features: [
      {
        head: 'Take a break.',
        line: 'Pause the emails for 1 to 60 days and they start again on their own, or stop them with one click. Nothing is deleted either way.',
        guide: '/guide/pause-and-stop/',
        tour: false
      },
      {
        head: 'Leave whenever you like.',
        line: 'Deleting your account takes every note, file and setting with it, and offers you a copy first.',
        guide: '/guide/delete/',
        tour: false
      }
    ]
  }
];

/** The groups and features the front page's tour shows, in order. */
export const tourGroups = () =>
  FEATURES.map((g) => ({ ...g, features: g.features.filter((f) => f.tour !== false) })).filter(
    (g) => g.features.length
  );
