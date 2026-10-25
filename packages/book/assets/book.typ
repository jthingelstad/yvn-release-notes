// A Release Notes book: one subscriber's notes for a span of days, as a 6 by
// 9 inch PDF. Every word comes from /data.json as a string (render.ts), so no
// note is ever read as markup; this template is the only code. Photos are
// /media/<file>, already resized and stripped of EXIF by render.ts.
#let data = json("/data.json")
#let ink = rgb("#14163a")
#let ink2 = rgb("#3b3d63")
#let ink3 = rgb("#6e7092")
#let blue = rgb("#1a4fe0")
#let orange = rgb("#ff5a1f")
#let mono = "Martian Mono"
// The front matter: the title page, and the contents when there are chapters.
#let front = if data.chapters.len() > 1 { 2 } else { 1 }

#let version(v, size: 15pt) = text(font: mono, weight: 700, size: size, fill: blue, tracking: -0.02em, v
  .split(".")
  .join(text(fill: orange, ".")))
#let kicker(s, fill: ink2) = text(font: mono, size: 7pt, tracking: 0.1em, fill: fill, upper(s))

#set document(title: data.title, author: "Release Notes")
#set text(font: ("Bricolage Grotesque", "Twemoji Mozilla"), size: 10.5pt, fill: ink, lang: "en", hyphenate: false)
#set par(leading: 0.62em, spacing: 0.95em)
#show link: set text(fill: blue)
#set page(width: 6in, height: 9in, margin: (inside: 0.8in, outside: 0.65in, top: 0.8in, bottom: 0.85in))

#page(margin: 0.8in, header: none, footer: none)[
  #v(1.2in)
  #kicker("Release Notes")
  #v(0.5em)
  #text(size: 34pt, weight: 800, data.title)
  #v(0.4em)
  #if data.range != "" { text(size: 12pt, fill: ink2, data.range) }
  #v(0.9em)
  #version(data.versions, size: 11pt)
  #v(1fr)
  #text(size: 9pt, fill: ink3, data.counts)
]

#set page(
  header: context {
    let n = here().page()
    let starts = query(heading.where(level: 1)).filter(h => h.location().page() == n)
    if starts.len() > 0 or n <= front { return }
    let before = query(heading.where(level: 1).before(here()))
    let name = if before.len() > 0 { before.last().body } else { data.title }
    align(if calc.odd(n) { right } else { left }, kicker(if calc.odd(n) { name } else { data.title }, fill: ink3))
  },
  footer: context {
    let n = here().page()
    if n <= front { return }
    align(if calc.odd(n) { right } else { left }, text(font: mono, size: 7.5pt, fill: ink3, str(n)))
  },
)

#if front == 2 {
  page[
    #kicker("Contents")
    #v(1em)
    #show outline.entry: it => block(above: 0.7em, link(it.element.location(), grid(
      columns: (1fr, auto),
      text(size: 11pt, it.element.body),
      text(font: mono, size: 8pt, fill: ink3, str(it.element.location().page())),
    )))
    #outline(title: none, depth: 1)
  ]
}

#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  v(1.1in)
  kicker(data.title, fill: ink3)
  v(0.3em)
  text(size: 26pt, weight: 800, it.body)
  v(0.9in)
}

#let span(s) = {
  if "href" in s { link(s.href, s.text) } else if "tag" in s { text(fill: blue, s.text) } else if "muted" in s {
    text(fill: ink3, s.text)
  } else { s.text }
}
#let photos(rows) = for row in rows {
  block(above: 0.8em, below: 0.8em, width: 100%, align(center, stack(
    dir: ltr,
    spacing: 6pt,
    ..row.map(p => image("/media/" + p.file, width: p.w * 1in, alt: p.at("alt", default: none))),
  )))
}

#for chapter in data.chapters {
  if front == 2 [= #chapter.name]
  for day in chapter.days {
    block(sticky: true, above: 2.4em, below: 1em)[
      #version(day.version)
      #v(0.45em, weak: true)
      #kicker(day.dateline)
    ]
    for (i, note) in day.notes.enumerate() {
      if i > 0 { v(1.1em) }
      if "by" in note { block(below: 0.5em, kicker(note.by, fill: ink3)) }
      for p in note.paragraphs { par(p.map(line => line.map(span).join()).join(linebreak())) }
      if "place" in note { block(above: 0.6em, kicker(note.place, fill: ink3)) }
      if note.photos.len() > 0 { photos(note.photos) }
      for a in note.audio {
        block(above: 0.7em, below: 0.4em, kicker(a.label))
        if "transcript" in a { text(fill: ink2, a.transcript) }
      }
      if note.files.len() > 0 { block(above: 0.6em, text(size: 8.5pt, fill: ink3, note.files.join(" · "))) }
    }
  }
}

#page(header: none, footer: none)[
  #v(1fr)
  #set text(size: 8.5pt, fill: ink2)
  #kicker("Colophon")
  #v(0.6em)
  #for line in data.colophon { par(line) }
]
