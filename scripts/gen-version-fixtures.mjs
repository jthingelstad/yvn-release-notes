// Regenerate tests/fixtures/versions.json from the site's own computeVersion.
//
//   node scripts/gen-version-fixtures.mjs [path-to-yourversionnumber.com]
//
// The site is a sibling checkout (default ../yourversionnumber.com). Its
// app.js is a browser module, so the function is lifted out by name with the
// site's own test helper, the same way the site's parity tests do it.
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, "..", process.argv[2] ?? "../yourversionnumber.com");
const { liftFunctions } = await import(pathToFileURL(resolve(site, ".github/tests/helpers.mjs")));
const { readFileSync } = await import("node:fs");
const source = readFileSync(resolve(site, "birthday/assets/app.js"), "utf8");
const { computeVersion } = liftFunctions(source, ["computeVersion", "anniversaryDate"]);

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

// Birthdays chosen for the edges: Feb 29, Mar 1, Dec 31, Jan 1, a decade
// boundary, and an ordinary one. Each is walked across leap and common years
// and both US DST changes, which is where a local-time JS port drifts.
const birthdays = ["1972-02-29", "1980-03-01", "1975-12-31", "2000-01-01", "1966-07-04", "2016-10-07", "2026-05-01"];
const days = [];
for (let d = new Date(2026, 0, 1); d < new Date(2029, 0, 1); d.setDate(d.getDate() + 1)) {
  days.push(new Date(d));
}

const cases = [];
for (const birthday of birthdays) {
  for (const today of days) {
    const [by] = birthday.split("-").map(Number);
    if (today.getFullYear() < by) continue;
    if (iso(today) < birthday) continue;
    const v = computeVersion(birthday, today);
    cases.push([birthday, iso(today), v.major, v.minor, v.patch, v.age, v.cycleDays, v.daysUntil]);
  }
}

const out = resolve(here, "../tests/fixtures/versions.json");
const fields = ["birthday", "today", "major", "minor", "patch", "age", "cycleDays", "daysUntil"];
const body = cases.map((c) => "  " + JSON.stringify(c)).join(",\n");
writeFileSync(
  out,
  `{"source": "yourversionnumber.com birthday/assets/app.js computeVersion",\n "fields": ${JSON.stringify(fields)},\n "cases": [\n${body}\n]}\n`,
);
console.log(`${cases.length} cases -> ${out}`);
