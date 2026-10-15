// The HTML of the developer comparison report (`npm run topics:report`, D21): one self-contained
// file, no script and no network (a Content-Security-Policy forbids both), with light and dark
// colors from custom properties, semantic tables with captions and header scopes, and verdicts
// written in words as well as colors. Developer tooling: its text is English and is not product
// copy. Every string that comes from a library (topic names, note titles, source titles) is
// escaped.
import type {
  ComparisonDocument,
  FreshComparison,
  ProfileReport,
  TargetCheck
} from "./report-core.js";

const escapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};
export const esc = (value: string | number | null | undefined): string =>
  String(value ?? "").replace(/[&<>"']/gu, (char) => escapes[char] as string);

const pct = (value: number | null, digits = 1): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(digits)}%`;
const fixed = (value: number | null, digits = 2): string =>
  value === null ? "n/a" : value.toFixed(digits);
const thousands = (value: number): string => value.toLocaleString("en-US");
const slug = (name: string): string => name.replace(/[^A-Za-z0-9_-]+/gu, "-");

function table(
  caption: string,
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
  options: { numeric?: boolean; className?: string } = {}
): string {
  // Headers are plain text; a header that starts with a tag is trusted markup of this file.
  const head = headers
    .map((header) => `<th scope="col">${header.startsWith("<") ? header : esc(header)}</th>`)
    .join("");
  const body = rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, at) => (at === 0 ? `<th scope="row">${cell}</th>` : `<td>${cell}</td>`))
          .join("")}</tr>`
    )
    .join("\n");
  const classes = [options.numeric === false ? "" : "numeric", options.className ?? ""]
    .filter(Boolean)
    .join(" ");
  return `<table${classes ? ` class="${classes}"` : ""}><caption>${esc(caption)}</caption><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

const verdictWords = { pass: "pass", fail: "FAIL", na: "n/a" } as const;
const badge = (status: TargetCheck["status"]): string =>
  `<span class="badge ${status}">${verdictWords[status]}</span>`;

function boundsText(check: TargetCheck): string {
  const min = check.min === null ? "" : `at least ${check.min}`;
  const max = check.max === null ? "" : `at most ${check.max}`;
  return [min, max].filter(Boolean).join(", ") || "reported";
}

function valueText(check: TargetCheck): string {
  if (check.value === null) return "n/a";
  const share = /share|churn|Reachability|Internal topics|Unsorted/u.test(check.name);
  if (share && check.value <= 1) return pct(check.value);
  return Number.isInteger(check.value) ? String(check.value) : check.value.toFixed(3);
}

// ---------------------------------------------------------------------------
// Sections

function summarySection(profiles: readonly ProfileReport[]): string {
  const rows = new Map<string, { id: string; name: string; gating: boolean }>();
  for (const profile of profiles)
    for (const check of profile.targets)
      rows.set(`${check.id} ${check.name}`, {
        id: check.id,
        name: check.name,
        gating: check.gating
      });
  const body = [...rows.values()].map((row) => {
    const cells = profiles.map((profile) => {
      const check = profile.targets.find((entry) => entry.id === row.id && entry.name === row.name);
      return check
        ? `${badge(check.status)} <span class="muted">${esc(valueText(check))}</span>`
        : "";
    });
    return [
      `${esc(row.id)} ${esc(row.name)}${row.gating ? "" : ' <span class="muted">(reported)</span>'}`,
      ...cells
    ];
  });
  return `<section id="summary" aria-labelledby="summary-title">
<h2 id="summary-title">Exit criteria by profile</h2>
${table("Each profile against the F2 exit criteria", ["Criterion", ...profiles.map((p) => p.name)], body, { numeric: false })}
<p class="muted">Gating criteria are E1 and E2. E3 here is read from the app's daily metrics (the E3 protocol is the weekly replay), D27 and E5 are reported only.</p>
</section>`;
}

function overviewSection(profile: ProfileReport): string {
  const { tree, library } = profile;
  const rows: Array<[string, string]> = [
    ["Tree", `${esc(tree.id)} (${esc(tree.status)}, generation ${tree.generation})`],
    [
      "Space",
      `${esc(tree.model)} on ${esc(tree.runtime)}, ${tree.dimensions} dimensions<br><span class="muted">${esc(tree.spaceKey)}</span>`
    ],
    ["Seed and configuration", `${tree.seed}, hash ${esc(tree.configHash.slice(0, 12))}`],
    ["Exported", esc(profile.exportedAt) + (profile.label ? ` (${esc(profile.label)})` : "")],
    [
      "Library",
      `${thousands(library.notes)} notes, ${thousands(library.rootSources)} root sources` +
        (library.vectorRows === null
          ? ", exported without vectors"
          : `, ${thousands(library.vectorRows)} vectors (${thousands(library.notesWithoutVector ?? 0)} notes without)`)
    ]
  ];
  return `<h3>Overview</h3>
<dl class="facts">${rows.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${value}</dd>`).join("")}</dl>`;
}

function targetsSection(profile: ProfileReport): string {
  const rows = profile.targets.map((check) => [
    `${esc(check.id)} ${esc(check.name)}${check.gating ? "" : ' <span class="muted">(reported)</span>'}`,
    esc(valueText(check)),
    esc(boundsText(check)),
    badge(check.status),
    check.note ? esc(check.note) : ""
  ]);
  return `<h3>Against the exit targets</h3>
${table("Measured values and bars", ["Measure", "Value", "Bar", "Verdict", "Note"], rows, { numeric: false })}`;
}

function bars(histogram: Record<string, number>, caption: string, unit: string): string {
  const entries = Object.entries(histogram);
  const max = Math.max(1, ...entries.map(([, value]) => value));
  const rows = entries.map(([bucket, value]) => [
    esc(bucket),
    `<div class="bar" aria-hidden="true"><span style="width:${((value / max) * 100).toFixed(1)}%"></span></div>`,
    String(value)
  ]);
  return table(caption, [unit, '<span class="visually-hidden">Bar</span>', "Topics"], rows, {
    className: "bars"
  });
}

function shapeSection(profile: ProfileReport): string {
  const { shape } = profile;
  const facts = table(
    "Shape of the exported tree",
    [
      "Items",
      "Topics",
      "Leaves",
      "Areas",
      "Mean depth",
      "p95 depth",
      "Single-child",
      "Coherence (leaf mean, p10)"
    ],
    [
      [
        thousands(shape.items),
        thousands(shape.topics),
        thousands(shape.leaves),
        shape.rootChildren,
        fixed(shape.depthMean),
        shape.depthP95,
        shape.singleChildTopics,
        `${fixed(shape.coherenceLeafWeighted, 3)}, ${fixed(shape.coherenceLeafP10, 3)}`
      ]
    ]
  );
  const levels = table(
    "Topics and notes per level (root = 0)",
    ["Level", "Topics", "Notes placed", "Unnamed topics"],
    profile.levels.map((level) => [
      level.depth,
      thousands(level.topics),
      thousands(level.notes),
      level.unnamed
    ])
  );
  return `<h3>Shape</h3>
${facts}
<div class="pair">${bars(profile.fanOutHistogram, "Children per internal topic (the root included)", "Children")}${bars(profile.leafSizeHistogram, "Items per leaf", "Items")}</div>
${levels}`;
}

function namingSection(profile: ProfileReport): string {
  const { naming } = profile;
  const list = (record: Record<string, number>): string =>
    Object.entries(record)
      .map(([key, value]) => `${esc(key)} ${value}`)
      .join(", ") || "none";
  return `<h3>Naming</h3>
<p>${thousands(naming.topics)} topics below the root: ${naming.named} named, ${naming.provisional} provisional, ${naming.unnamed} unnamed.
By source: ${list(naming.bySource)}. By language: ${list(naming.byLanguage)}.</p>`;
}

function placementSection(profile: ProfileReport): string {
  const { placements, gate } = profile;
  const margin = placements.margin;
  const decisions = table(
    "Primary note placements by how they were decided",
    ["Decided by", "Notes"],
    Object.entries(placements.byDecision).map(([key, value]) => [esc(key), thousands(value)])
  );
  const open = table(
    "Placements waiting for something",
    ["Waiting", "Items"],
    [
      ["Gate (needs_gate)", placements.needsGate],
      ["Split check (needs_split_check)", placements.needsSplitCheck],
      ["Vector (needs_vector)", placements.needsVector],
      ["At the root (Unsorted)", placements.atRoot]
    ]
  );
  const gateRows = table(
    "The gate (dedicated ranker, D10)",
    ["Decisions", "Accepted", "None of these", "Candidates per call", "Still in the chosen topic"],
    [
      [
        gate.decisions,
        gate.accepted,
        gate.none,
        fixed(gate.candidatesMean),
        pct(gate.stillInChosen)
      ]
    ]
  );
  const byDecider = Object.entries(gate.byDecider)
    .map(([key, value]) => `${esc(key)} ${value}`)
    .join(", ");
  return `<h3>Placements and the gate</h3>
<div class="pair">${decisions}${open}</div>
${gateRows}
<p class="muted">${byDecider ? `Deciders: ${byDecider}. ` : "No gate decision is recorded. "}Margins of ${margin.n} automatic placements: p10 ${fixed(margin.p10, 3)}, median ${fixed(margin.p50, 3)}, p90 ${fixed(margin.p90, 3)}; below 0.01 ${pct(margin.below["0.01"] ?? 0)}, 0.02 ${pct(margin.below["0.02"] ?? 0)}, 0.03 ${pct(margin.below["0.03"] ?? 0)}, 0.05 ${pct(margin.below["0.05"] ?? 0)}.</p>`;
}

function sparkline(values: readonly number[], label: string): string {
  if (values.length < 2) return "";
  const width = 320;
  const height = 48;
  const max = Math.max(...values, 1e-9);
  const points = values
    .map((value, at) => {
      const x = (at / (values.length - 1)) * (width - 4) + 2;
      const y = height - 4 - (value / max) * (height - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
}

function churnSection(profile: ProfileReport): string {
  const { churn, changeSets } = profile;
  const days =
    churn.days.length === 0
      ? '<p class="muted">The export has no daily metrics yet.</p>'
      : sparkline(
          churn.days.map((day) => day.primaryPathChanges),
          "Primary-path changes per day"
        ) +
        table(
          "Daily metrics of the tree",
          [
            "Day",
            "Operations",
            "Items moved",
            "Path changes",
            "Churn",
            "Gate calls",
            "Naming calls",
            "Mean depth",
            "Fan-out 4-9",
            "Hard"
          ],
          churn.days.map((day) => [
            esc(day.day),
            day.opsApplied,
            day.itemsMoved,
            day.primaryPathChanges,
            pct(day.churn, 2),
            day.gateCalls,
            day.namingCalls,
            fixed(day.meanDepth),
            pct(day.fanoutInTarget),
            day.hardViolations ?? "n/a"
          ])
        );
  const origins = Object.keys(changeSets.byOrigin);
  const perDay =
    changeSets.perDay.length === 0
      ? ""
      : table(
          `Change-sets per day by origin (${changeSets.listed} of ${changeSets.total} listed)`,
          ["Day", "Total", ...origins.map(esc)],
          changeSets.perDay.map((day) => [
            esc(day.day),
            day.total,
            ...origins.map((origin) => day.byOrigin[origin] ?? 0)
          ])
        );
  const statuses = Object.entries(changeSets.byStatus)
    .map(([key, value]) => `${esc(key)} ${value}`)
    .join(", ");
  return `<h3>Churn and change-sets per day</h3>
${days}
<p class="muted">${changeSets.total} change-sets (${statuses || "none"}); undone share of the automatic ones ${pct(changeSets.undoRate)}. ${churn.worstWeek === null ? "" : `Worst seven days: ${pct(churn.worstWeek, 2)} of the items.`}</p>
${perDay}`;
}

function freshSection(profile: ProfileReport): string {
  const fresh: FreshComparison | null = profile.fresh;
  if (fresh === null)
    return '<h3>Incremental tree against a fresh build</h3><p class="muted">Not computed for this profile.</p>';
  const row = (name: string, side: FreshComparison["app"]): Array<string | number> => [
    name,
    thousands(side.shape.items),
    thousands(side.shape.topics),
    side.shape.rootChildren,
    fixed(side.shape.depthMean),
    pct(side.shape.fanOutInTarget),
    pct(side.shape.leafInRange),
    fixed(side.shape.coherenceLeafWeighted, 3),
    side.shape.hardViolations,
    `<code>${esc(side.partitionHash.slice(0, 16))}</code>`
  ];
  const verdict = fresh.identical
    ? '<span class="badge pass">same partition</span>'
    : '<span class="badge na">differs</span>';
  const later = Object.entries(fresh.laterChangeSets)
    .map(([origin, total]) => `${esc(origin)} ${total}`)
    .join(", ");
  return `<h3>Incremental tree against a fresh build</h3>
<p>${verdict} The fresh build is the offline engine on this export's ${thousands(fresh.rows)} vectors in content-key order, seed ${fresh.seed}, configuration ${esc(fresh.configHash.slice(0, 12))} (${fresh.buildMs.toFixed(0)} ms).
${fresh.unplaced > 0 ? `${fresh.unplaced} notes are not placed in the app's tree and ${fresh.placedOnRetired} sit on retired topics. ` : ""}${later ? `Change-sets after the build: ${later}.` : "The tree has only its build."}</p>
${table("Shapes side by side", ["Tree", "Items", "Topics", "Areas", "Mean depth", "Fan-out 4-9", "Leaves 3-30", "Leaf coherence", "Hard", "Partition"], [row("In-app (incremental)", fresh.app), row("Fresh build", fresh.fresh)])}
${table("Agreement between the two trees (NMI, 1 is the same partition)", ["Leaves", "Level 1", "Level 2", "Areas as a cut"], [[fixed(fresh.agreement.leafNmi, 3), fixed(fresh.agreement.depth1Nmi, 3), fixed(fresh.agreement.depth2Nmi, 3), fixed(fresh.agreement.cutNmi, 3)]])}`;
}

function truthSection(profile: ProfileReport): string {
  const { truth } = profile;
  if (truth === null) return "";
  const row = (name: string, value: NonNullable<ProfileReport["truth"]>["app"]) =>
    value
      ? [
          name,
          pct(value.leafDomainPurity),
          fixed(value.depth1NmiDomain),
          fixed(value.depth2NmiDomain),
          fixed(value.leafNmiGroup)
        ]
      : [name, "n/a", "n/a", "n/a", "n/a"];
  return `<h3>Agreement with the ground truth</h3>
<p class="muted">Labels from ${esc(truth.source)}, joined by language and article title for ${pct(truth.coverage)} of the notes.</p>
${table("Domain purity and NMI", ["Tree", "Leaf domain purity", "Level 1 NMI (domain)", "Level 2 NMI (domain)", "Leaf NMI (article)"], [row("In-app", truth.app), row("Fresh build", truth.fresh)])}`;
}

function samplesSection(profile: ProfileReport): string {
  if (profile.samples.length === 0) return "";
  const items = profile.samples
    .map((sample) => {
      const title = sample.title === null ? "Unnamed topic" : sample.title;
      const members = sample.members
        .map(
          (member) =>
            `<li>${esc(member.title)}${member.source ? ` <span class="muted">in ${esc(member.source)}</span>` : ""} <span class="muted">cos ${fixed(member.cosine, 3)}</span></li>`
        )
        .join("");
      return `<details><summary><strong>${esc(title)}</strong> <span class="muted">${esc(sample.stratum)}, level ${sample.depth}, ${thousands(sample.notes)} notes, ${sample.children} children, coherence ${fixed(sample.coherence, 3)}, name ${esc(sample.nameState)}${sample.nameSource ? ` (${esc(sample.nameSource)})` : ""}</span></summary>
${sample.description ? `<p>${esc(sample.description)}</p>` : ""}${sample.aliases.length > 0 ? `<p class="muted">Also: ${sample.aliases.map(esc).join(", ")}</p>` : ""}
<p class="muted">Central members (mean cosine to the centroid ${fixed(sample.centralCosine, 3)}):</p><ol>${members}</ol></details>`;
    })
    .join("\n");
  return `<h3>Sampled topics</h3>
<p class="muted">A seeded draw by stratum (Areas, level 2, deeper), each with the five members closest to its centroid. Names and titles come from the exported library.</p>
${items}`;
}

function legacySection(profile: ProfileReport): string {
  const { legacy } = profile;
  if (legacy === null) return "";
  return `<h3>The legacy wiki this tree replaced</h3>
<p>Recorded ${esc(legacy.recordedOn)} (${esc(legacy.source)}): ${legacy.pages} area pages with ${legacy.revisions} revisions in ${legacy.levels} level (a flat set of pages), over ${legacy.library.sources} sources, ${legacy.library.chunks} chunks, ${legacy.library.notes} notes and ${legacy.library.vectors} vectors. ${thousands(legacy.rowsWiped)} legacy rows were wiped and nothing of it is read any more.</p>`;
}

function profileSection(profile: ProfileReport): string {
  const caveats =
    profile.caveats.length === 0
      ? ""
      : `<aside class="caveat" role="note"><strong>Read with care.</strong><ul>${profile.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></aside>`;
  return `<section id="profile-${slug(profile.name)}" aria-labelledby="title-${slug(profile.name)}">
<h2 id="title-${slug(profile.name)}">${esc(profile.name)}</h2>
${caveats}
${overviewSection(profile)}
${targetsSection(profile)}
${shapeSection(profile)}
${freshSection(profile)}
${truthSection(profile)}
${namingSection(profile)}
${placementSection(profile)}
${churnSection(profile)}
${samplesSection(profile)}
${legacySection(profile)}
</section>`;
}

const styles = `
:root{color-scheme:light dark;--bg:#fbfbfa;--fg:#1d1f21;--muted:#5b6168;--line:#d9dcdf;--surface:#f1f2f3;--accent:#2b5fa8;--pass:#1f6f43;--pass-bg:#dff3e7;--fail:#a02020;--fail-bg:#fbe3e3;--na:#6a5a12;--na-bg:#f6efcf}
@media (prefers-color-scheme:dark){:root{--bg:#16181a;--fg:#e8eaec;--muted:#a3aab1;--line:#33383d;--surface:#202326;--accent:#8db6f0;--pass:#7fd3a1;--pass-bg:#173626;--fail:#ff9d9d;--fail-bg:#401c1c;--na:#e6d58a;--na-bg:#3a3414}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
header,main,footer{max-width:1180px;margin:0 auto;padding:0 16px}
header{padding-top:24px}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.25rem;margin:32px 0 8px;border-top:1px solid var(--line);padding-top:16px}h3{font-size:1.05rem;margin:24px 0 8px}
a{color:var(--accent)}code{font-family:ui-monospace,monospace;font-size:.9em}
.muted{color:var(--muted)}
nav ul{list-style:none;display:flex;flex-wrap:wrap;gap:8px 16px;padding:0;margin:12px 0}
table{border-collapse:collapse;width:100%;margin:8px 0 16px;font-size:.9rem}
caption{text-align:left;font-weight:600;padding:4px 0}
th,td{border-bottom:1px solid var(--line);padding:4px 8px;text-align:left;vertical-align:top}
thead th{background:var(--surface)}
table.numeric td,table.numeric thead th:not(:first-child){text-align:right;font-variant-numeric:tabular-nums}
table.numeric th[scope=row]{text-align:left}
table.bars td:nth-child(2){width:50%;text-align:left}
.visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.badge{display:inline-block;border-radius:4px;padding:0 6px;font-weight:600;font-size:.8rem}
.badge.pass{color:var(--pass);background:var(--pass-bg)}.badge.fail{color:var(--fail);background:var(--fail-bg)}.badge.na{color:var(--na);background:var(--na-bg)}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}.facts dt{color:var(--muted)}.facts dd{margin:0}
.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:0 24px}
.bar{background:var(--surface);height:10px;border-radius:5px;min-width:120px}.bar span{display:block;height:100%;background:var(--accent);border-radius:5px}
.spark{width:100%;max-width:420px;height:48px;color:var(--accent)}
details{border:1px solid var(--line);border-radius:6px;padding:6px 12px;margin:6px 0}summary{cursor:pointer}
.caveat{border:1px solid var(--line);background:var(--na-bg);color:var(--na);border-radius:6px;padding:8px 12px;margin:12px 0}
footer{padding:24px 16px 48px;color:var(--muted)}
@media (max-width:640px){body{font-size:14px}.facts{grid-template-columns:1fr}table{display:block;overflow-x:auto}}
`;

export function renderReportHtml(document: ComparisonDocument): string {
  const profiles = document.profiles;
  const nav = profiles
    .map((profile) => `<li><a href="#profile-${slug(profile.name)}">${esc(profile.name)}</a></li>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Topic tree comparison</title>
<style>${styles}</style>
</head>
<body>
<header>
<h1>Topic tree comparison</h1>
<p class="muted">Generated ${esc(document.createdAt)} by <code>npm run topics:report</code> (${esc(document.schema)}). It reads topic exports and their vector stores, never a live database. It holds topic names and note titles of the exported libraries: keep it in <code>.cache/</code>.</p>
<nav aria-label="Profiles"><ul><li><a href="#summary">Summary</a></li>${nav}</ul></nav>
</header>
<main>
${summarySection(profiles)}
${profiles.map(profileSection).join("\n")}
</main>
<footer>Developer tooling for F2 (decision D21). Exit criteria: spec section 8 of the F2 plan.</footer>
</body>
</html>
`;
}
