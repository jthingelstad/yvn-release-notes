// A Release Notes book: one subscriber's notes for a span of days, as a PDF
// at 6 by 9 inches or US Letter (data.page, in inches, from data.ts). Every
// word comes from /data.json as a string (render.ts), so no note is ever read
// as markup; this template is the only code. Claude's commentary, when the
// maker asked for it, is set apart: an aside with a rule, or a page of its
// own. Photos are /media/<file>, already resized and stripped of EXIF by
// render.ts.
//
// A day opens with its version, date, weather and place: hung in a rail
// beside the notes on US Letter, stacked above them on the 6 by 9. Its photos
// come first, so the opening never strands at a page's foot without them.
#let data = json("/data.json")
#let page-size = data.page
// Type and space grow with the page: sizes are the 6 by 9's, in points.
#let k = page-size.scale
#let pt(n) = n * k * 1pt
#let ink = rgb("#14163a")
#let ink2 = rgb("#3b3d63")
#let ink3 = rgb("#6e7092")
#let blue = rgb("#1a4fe0")
#let orange = rgb("#ff5a1f")
// Claude's commentary (commentary.ts) and agents' notes hang from this rule.
#let rule = rgb("#c3d0f5")
#let faint = rgb("#dfe4f3")
#let mono = "Martian Mono"
#let rail = page-size.rail * 1in
#let gap = page-size.gap * 1in
#let text-width = (page-size.width - page-size.inside - page-size.outside) * 1in
#let column-width = text-width - rail - gap
#let days = data.chapters.map(c => c.days.len()).sum()
#let indexed = days >= 3 and data.index.tags.len() + data.index.places.len() > 0
// The contents, when there is more than one month or an index to find.
#let contents = data.chapters.len() > 1 or indexed
// The Release Notes mark, as the web app draws it (web/public/brand).
#let mark = bytes(
  "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><path fill=\"#1a4fe0\" d=\"M12 12h19l14 38 14-38h19L57 64H33Z\"/><path fill=\"#ff5a1f\" d=\"M89 54a11 11 0 1 1-22 0 11 11 0 0 1 22 0\"/><path fill=\"#1a4fe0\" d=\"M18 72h68a3 3 0 0 1 0 6H18a3 3 0 0 1 0-6ZM18 85h46a3 3 0 0 1 0 6H18a3 3 0 0 1 0-6Z\"/></svg>",
)
#let wave = bytes(
  "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 14 12\"><path d=\"M1 5v2M4 3v6M7 1v10M10 3v6M13 5v2\" fill=\"none\" stroke=\"#3b3d63\" stroke-width=\"1.5\" stroke-linecap=\"round\"/></svg>",
)

#let dotted(v) = v.split(".").join(text(fill: orange, "."))
#let version(v, size: pt(15)) = text(font: mono, weight: 700, size: size, fill: blue, tracking: -0.02em, dotted(v))
// "5.4.276 to 5.4.294", or one version, in the book's numbers.
#let versions(s, size: pt(9)) = {
  let joiner = text(font: mono, size: size, fill: ink3, " to ")
  s.split(" to ").map(v => version(v, size: size)).join(joiner)
}
#let kicker(s, fill: ink2, size: pt(7)) = text(font: mono, size: size, tracking: 0.1em, fill: fill, upper(s))

#set document(title: data.title, author: "Release Notes")
#set text(font: ("Bricolage Grotesque", "Twemoji Mozilla"), size: pt(10.5), fill: ink, lang: "en", hyphenate: false)
#set par(leading: 0.62em, spacing: 0.95em)
#show link: set text(fill: blue)
#set page(width: page-size.width * 1in, height: page-size.height * 1in, margin: (
  inside: page-size.inside * 1in,
  outside: page-size.outside * 1in,
  top: page-size.top * 1in,
  bottom: page-size.bottom * 1in,
))
#show heading.where(level: 1): it => block(above: 0pt, below: 0.5em, text(
  size: pt(30),
  weight: 800,
  tracking: -0.025em,
  it.body,
))

// The title page: the title as large as it fits, the span, every release in
// it with the noted ones raised, and the book's figures.
#page(margin: (x: page-size.outside * 1in, top: page-size.top * 1in, bottom: page-size.bottom * 1in), header: none, footer: none)[
  #grid(columns: 2, column-gutter: 0.7em, align: horizon, image(mark, height: pt(20)), kicker("Release Notes"))
  #v(1in * k)
  #layout(size => {
    let release = data.title.match(regex("^\d+(\.\d+)+$")) != none
    let words = if release { dotted(data.title) } else { data.title }
    let set-in(n) = text(size: n, weight: 800, tracking: -0.04em, words)
    let fit = size.width / measure(set-in(100pt)).width * 100pt
    let n = calc.max(pt(30), calc.min(pt(150), fit * 0.98))
    block(above: 0pt, below: 0pt, par(leading: 0.15em, set-in(n)))
  })
  #v(0.35in * k)
  #if data.range != "" { block(below: 0.8em, text(size: pt(14), fill: ink2, data.range)) }
  #versions(data.versions, size: pt(11))
  #v(1fr)
  #if data.strip.total >= 14 {
    let s = data.strip
    grid(
      columns: (1fr, auto),
      kicker(str(s.total) + " releases"), kicker(str(s.noted.len()) + " with notes"),
    )
    v(0.6em)
    layout(size => {
      let unit = size.width / s.total
      let bar = calc.min(calc.max(unit * 0.7, 0.6pt), pt(5))
      block(width: 100%, height: pt(30), above: 0pt, below: 0pt, {
        place(bottom + left, rect(width: 100%, height: pt(3), fill: faint))
        for i in s.noted { place(bottom + left, dx: i * unit, rect(width: bar, height: pt(30), fill: blue)) }
      })
      block(width: 100%, height: pt(14), above: 0.3em, below: 0pt, stroke: (top: 0.5pt + rule), for m in s.marks {
        place(top + left, dx: m.at * unit, block(
          inset: (left: 2pt, top: 3pt),
          stroke: (left: 0.5pt + rule),
          text(font: mono, size: pt(6), fill: ink3, m.label),
        ))
      })
    })
    v(0.3in * k)
  }
  #block(width: 100%, stroke: (top: 1.5pt + ink), inset: (top: 0.9em), grid(
    columns: (1fr,) * 4,
    column-gutter: 1em,
    ..data.stats.map(f => stack(
      spacing: 0.6em,
      text(size: pt(24), weight: 800, tracking: -0.03em, f.n),
      kicker(f.label),
    )),
  ))
]

// Each day leaves its version here, for the running head.
#let day-mark(v) = [#metadata(v) <day>]

#set page(
  header: context {
    let n = here().page()
    let start = query(<opened>)
    if start.len() == 0 or n < start.first().location().page() { return }
    if query(heading.where(level: 1)).any(h => h.location().page() == n) { return }
    let index = query(<index>)
    // The days that open on this page, and the one it goes on with, if any.
    let shown = if index.len() > 0 and n >= index.first().location().page() { () } else {
      let marks = query(<day>)
      let opening = marks.filter(m => m.location().page() == n)
      let before = marks.filter(m => m.location().page() < n)
      let top = page-size.top * 1in + 6pt
      let continued = (
        before.len() > 0 and (opening.len() == 0 or opening.first().location().position().y > top)
      )
      (if continued { (before.last().value,) } else { () }) + opening.map(m => m.value)
    }
    let range = if shown.len() == 0 { none } else if shown.first() == shown.last() { shown.first() } else {
      shown.first() + " to " + shown.last()
    }
    let before = query(heading.where(level: 1).before(here()))
    let name = if calc.odd(n) and before.len() > 0 { before.last().body } else { data.title }
    let dot = text(fill: rule, "  ·  ")
    let parts = if range == none { (kicker(name, fill: ink3),) } else if calc.odd(n) {
      (kicker(range, fill: ink3), kicker(name, fill: ink3))
    } else { (kicker(name, fill: ink3), kicker(range, fill: ink3)) }
    align(if calc.odd(n) { right } else { left }, parts.join(dot))
  },
  footer: context {
    let n = here().page()
    let start = query(<opened>)
    if start.len() == 0 or n < start.first().location().page() { return }
    align(if calc.odd(n) { right } else { left }, text(font: mono, size: pt(7.5), fill: ink3, str(n)))
  },
)

// A month, as a strip of its days with the noted ones filled.
#let month-strip(m) = layout(size => {
  let cell = (size.width - 30 * 2pt) / 31
  grid(
    columns: (cell,) * 31,
    column-gutter: 2pt,
    ..range(1, m.length + 1).map(d => {
      let noted = d in m.noted
      let inside = d >= m.first and d <= m.last
      box(
        width: cell,
        height: pt(13),
        fill: if noted { blue } else { none },
        stroke: if noted { none } else if inside { 0.5pt + faint } else { none },
        align(center + horizon, text(font: mono, size: pt(5), fill: if noted { white } else if inside { ink3 } else {
          faint
        }, str(d))),
      )
    }),
  )
})
// A month as a calendar of dots, for the contents.
#let month-dots(m) = {
  let dot = pt(5.5)
  stack(
    spacing: 0.7em,
    kicker(m.label, size: pt(6)),
    grid(
      columns: (dot,) * 7,
      gutter: pt(3),
      ..range(m.starts).map(_ => none),
      ..range(1, m.length + 1).map(d => if d in m.noted { circle(radius: dot / 2, fill: blue) } else if (
        d >= m.first and d <= m.last
      ) { circle(radius: dot / 2, stroke: 0.5pt + rule) } else { none }),
    ),
  )
}

#if contents {
  page[
    #kicker("Contents")
    #v(1.4em)
    #let entry(key, name, detail) = context {
      let found = query(<entry>).filter(m => m.value == key)
      let at = if found.len() > 0 { found.first().location() } else { none }
      let row = grid(
        columns: (1fr, auto),
        align: (left, right + bottom),
        stack(spacing: 0.55em, text(size: pt(15), weight: 800, tracking: -0.02em, name), detail),
        if at != none { text(font: mono, size: pt(9), fill: ink2, str(at.page())) },
      )
      block(width: 100%, above: 0pt, below: 0pt, inset: (y: 0.75em), stroke: (top: 0.5pt + faint), if at != none {
        link(at, row)
      } else { row })
    }
    #if "introduction" in data { entry("introduction", "Introduction", kicker("By Claude", fill: ink3, size: pt(6.5))) }
    #for (i, c) in data.chapters.enumerate() {
      entry("chapter-" + str(i), c.name, kicker(
        (if c.days.len() == 1 { "1 day" } else { str(c.days.len()) + " days" }) + " · " + c.versions,
        fill: ink3,
        size: pt(6.5),
      ))
    }
    #if "afterword" in data { entry("afterword", "Afterword", kicker("By Claude", fill: ink3, size: pt(6.5))) }
    #if indexed { entry("index", "Index", kicker("Tags and places", fill: ink3, size: pt(6.5))) }
    #block(width: 100%, above: 0pt, stroke: (top: 0.5pt + faint))
    #if data.calendar.len() > 1 {
      v(1fr)
      block(width: 100%, below: 1.2em, inset: (bottom: 0.7em), stroke: (bottom: 0.5pt + rule), grid(
        columns: (1fr, auto),
        kicker("The span in releases"),
        text(size: pt(8.5), fill: ink2, str(days) + " of " + str(data.strip.total) + " days have notes"),
      ))
      grid(
        columns: (1fr,) * (if page-size.rail > 0 { 5 } else { 4 }),
        row-gutter: 1.6em,
        column-gutter: 1em,
        ..data.calendar.map(month-dots),
      )
    }
  ]
}

#let span(s) = {
  if "href" in s { link(s.href, s.text) } else if "tag" in s { text(fill: blue, s.text) } else if "muted" in s {
    text(fill: ink3, s.text)
  } else { s.text }
}
#let spans(l) = l.map(span).join()
// A piece of Claude's commentary, set apart from the notes.
#let aside(paragraphs) = block(above: 1.4em, below: 0.4em, inset: (left: 0.9em), stroke: (left: 1.2pt + rule), {
  block(below: 0.55em, kicker("Claude", fill: ink3))
  set text(size: pt(9.75), fill: ink2)
  for p in paragraphs { par(p) }
})
// The introduction and afterword: whole pages by Claude, in the contents.
#let essay(key, name, paragraphs) = {
  pagebreak(weak: true)
  v(0.6in * k)
  heading(level: 1, name)
  [#metadata(key) <entry>]
  block(below: 1.4em, kicker("By Claude", fill: ink3))
  set text(fill: ink2)
  for p in paragraphs { par(p) }
}

// Photos in their rows, at their sizes, made smaller only when a note's rule
// takes some of the column.
#let photos(rows) = for row in rows {
  block(above: 0pt, below: 6pt, width: 100%, layout(size => {
    let wide = row.map(p => p.w * 1in).sum() + 6pt * (row.len() - 1)
    let f = calc.min(1, size.width / wide)
    stack(dir: ltr, spacing: 6pt, ..row.map(p => image(
      "/media/" + p.file,
      width: p.w * 1in * f,
      alt: p.at("alt", default: none),
    )))
  }))
}

#let note-words(note) = {
  if note.photos.len() > 0 {
    photos(note.photos)
    v(0.5em)
  }
  set list(marker: move(dy: 0.1em, circle(radius: pt(1.7), fill: orange)), indent: 0.1em, body-indent: 0.8em, spacing: 0.5em)
  for b in note.blocks {
    let above = if "tight" in b { 0.55em } else { 0.95em }
    if b.kind == "head" {
      block(above: above + 0.2em, below: 0.55em, sticky: true, text(weight: 700, spans(b.lines.first())))
    } else if b.kind == "list" {
      block(above: above, below: 0.95em, list(..b.lines.map(spans)))
    } else { block(above: above, below: 0.95em, par(b.lines.map(spans).join(linebreak()))) }
  }
  if "place" in note { block(above: 0.65em, kicker(note.place, fill: ink3, size: pt(6.5))) }
  for a in note.audio {
    block(above: 0.9em, below: 0.45em, grid(
      columns: 2,
      column-gutter: 0.5em,
      align: horizon,
      image(wave, height: pt(6)),
      kicker(a.label, size: pt(6.5)),
    ))
    if "transcript" in a { block(above: 0pt, text(fill: ink2, "“" + a.transcript + "”")) }
  }
  if note.files.len() > 0 {
    block(above: 0.75em, [#kicker("Attached", fill: ink3, size: pt(6.5))#h(0.6em)#text(
        size: pt(8.5),
        fill: ink3,
        note.files.join(" · "),
      )])
  }
}
// A note an agent added on the subscriber's behalf hangs from a rule, in
// ink2, so the subscriber's own words read first.
#let note(n) = if "by" in n {
  block(width: 100%, above: 0pt, below: 0pt, inset: (left: 0.9em), stroke: (left: 1.2pt + rule), {
    block(above: 0pt, below: 0.7em, kicker(n.by, fill: ink3, size: pt(6.5)))
    set text(size: pt(10), fill: ink2)
    note-words(n)
  })
} else { note-words(n) }
#let day-body(day) = {
  for (i, n) in day.notes.enumerate() {
    if i > 0 { v(1.3em) }
    note(n)
  }
  if "annotation" in day { aside(day.annotation) }
}

// The day's weather, and its place: one quiet line, or a few in the rail.
#let sky(day) = {
  let parts = ()
  if "weather" in day { parts += day.weather.split(", ") }
  if "where" in day { parts.push(day.where) }
  parts
}
#let day-rail(day) = {
  day-mark(day.version)
  version(day.version, size: pt(13))
  v(0.5em, weak: true)
  let (weekday, ..date) = day.date.split(", ")
  block(above: 0pt, below: 0.6em, par(leading: 0.35em, text(weight: 700, size: pt(10), [#weekday#linebreak()#date.join(", ")])))
  par(leading: 0.55em, sky(day).map(p => kicker(p, fill: ink3, size: pt(6))).join(linebreak()))
}
#let day-stacked(day) = block(
  sticky: true,
  above: 2.2em,
  below: 1em,
  width: 100%,
  inset: (bottom: 0.6em),
  stroke: (bottom: 0.5pt + rule),
  {
    day-mark(day.version)
    version(day.version)
    v(0.5em, weak: true)
    grid(
      columns: (auto, 1fr),
      column-gutter: 1em,
      align: (left + bottom, right + bottom),
      text(weight: 700, size: pt(10.5), day.date),
      kicker(sky(day).join(" · "), fill: ink3, size: pt(6)),
    )
  },
)
// On a page with a rail, the opening is a block as tall as the rail's words,
// kept with what follows it, which then rises beside it; a day shorter than
// its opening is lengthened to fit.
#let day(d) = if rail == 0pt {
  day-stacked(d)
  day-body(d)
} else {
  context {
    let head = block(width: rail, day-rail(d))
    let tall = measure(head).height
    let body = day-body(d)
    let long = measure(block(width: column-width, body)).height
    block(sticky: true, breakable: false, above: 2.6em, below: 0pt, width: 100%, height: tall, place(top + left, head))
    v(-tall)
    block(above: 0pt, below: 0pt, inset: (left: rail + gap), body)
    if long < tall { v(tall - long) }
  }
}

#let opener(i, chapter) = {
  pagebreak(weak: true)
  versions(chapter.versions, size: pt(8.5))
  v(0.55em)
  heading(level: 1, chapter.name)
  [#metadata("chapter-" + str(i)) <entry>]
  if "month" in chapter and chapter.month != none {
    v(0.4em)
    month-strip(chapter.month)
  }
  block(width: 100%, above: 0.9em, below: 0.4em, inset: (bottom: 0.9em), stroke: (bottom: 0.5pt + rule), kicker(
    chapter.counts,
    size: pt(6.5),
  ))
  if "opening" in chapter { aside(chapter.opening) }
}

// The first page of the book proper: no page before it has a head or folio.
#[#metadata(none) <opened>]
#if "introduction" in data { essay("introduction", "Introduction", data.introduction) }

#for (i, chapter) in data.chapters.enumerate() {
  if contents { opener(i, chapter) } else {
    pagebreak(weak: true)
    if "opening" in chapter { aside(chapter.opening) }
  }
  for d in chapter.days { day(d) }
}

#if "afterword" in data { essay("afterword", "Afterword", data.afterword) }

#let entries(name, list) = if list.len() > 0 {
  block(above: 1.6em, below: 0.6em, width: 100%, inset: (bottom: 0.5em), stroke: (bottom: 0.5pt + rule), kicker(name))
  columns(if rail > 0pt { 2 } else { 1 }, gutter: 1.6em, for e in list {
    block(above: 0pt, below: 0pt, width: 100%, inset: (y: 0.32em), stroke: (bottom: 0.5pt + faint), grid(
      columns: (auto, 1fr),
      column-gutter: 0.8em,
      align: (left, right),
      text(size: pt(9.5), fill: if name == "Tags" { blue } else { ink }, e.name),
      text(font: mono, size: pt(7), fill: ink2, e.refs),
    ))
  })
}
#if indexed {
  pagebreak(weak: true)
  v(0.6in * k)
  [#heading(level: 1, "Index") <index>]
  [#metadata("index") <entry>]
  if "short" in data.index {
    text(size: pt(9.5), fill: ink2, "Numbers are releases in " + data.index.short + ": 12 is " + data.index.short + ".12.")
  }
  entries("Tags", data.index.tags)
  entries("Places", data.index.places)
}

#page(header: none, footer: none)[
  #v(1fr)
  #set text(size: pt(8.5), fill: ink2)
  #block(width: 100%, inset: (top: 1.2em), stroke: (top: 0.5pt + rule), grid(
    columns: (pt(26), 1fr),
    column-gutter: 1.2em,
    image(mark, width: pt(22)),
    {
      kicker("Colophon")
      v(0.6em)
      for line in data.colophon { par(line) }
    },
  ))
]
