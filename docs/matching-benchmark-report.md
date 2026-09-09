# Expanded matching benchmark — DEV

Completed on 2026-09-09. Economy with source importance 0.85 is saved and applied
in DEV. Held-out validation completed with unchanged frozen settings. This is a
measured practical starting point, not a claim of a universal optimum.

## Scope and controls

The synthetic corpus has 60 roots and 82 records including chapters. Forty
roots were used for tuning (including the pilot's 12 roots); 20 roots remained
unseen until configuration selection. Tuning contains 120 extracted atomic
notes. Assessment labels and expected answers are excluded from model inputs.

All runs use the unpackaged DEV app and DEV PostgreSQL database. The original
pilot settings are preserved in `matching-pilot-settings.json`. Full local
backups precede preparation, each matching reset and final graph restoration.
Canonical source content, evidence, extracted notes and graph facts are reused
and fingerprinted across tuning passes. Only unreviewed matching results and
matching decisions are reset. Model profiles remain unchanged.

The comparison uses the Luna profile (`gpt-5.6-luna`, low reasoning) and local
Qwen3 0.6B embeddings. Its ceiling is 5,000,000 reported input-plus-output tokens
for the new benchmark, separate from the earlier pilot. Reported usage includes
local embeddings and observed retries; reasoning tokens are already included
in output and are not added again. Two interrupted calls have unavailable
usage. Remote monetary cost is unavailable, so these are not billing totals.

## Tuning observations

| Configuration | Reported tokens | Note relations | Expected root pairs linked by notes | Source relations | Expected source pairs |
| --- | ---: | ---: | ---: | ---: | ---: |
| Reference | 906,059 | 140 | 22/26 | 102 | 26/26 |
| Economy | 680,003 | 139 | 23/26 | 88 | 26/26 |
| Coverage | 1,245,734 | 148 | 24/26 | 130 | 26/26 |

Preparation consumed 389,195 reported tokens. All configurations have zero
connections in the explicitly forbidden cases. Reference and economy have
zero connections to the designated nonconceptual examples. Coverage has one
source connection from F4's art catalogue to L2's contextual-meaning principle
at importance 0.82; the 0.85 floor removes it. This is case-based screening, not
precision over every generated relation. Unlabelled connections include useful
cross-domain bridges and require separate judgment.

All 40 roots reached their configured pair allowance in each pass; none reached
the ten-proposal ceiling. Maximum reported source-matching input per root was
19,962 tokens in reference, 13,813 in economy and 27,141 in coverage, below the
unchanged 60,000-token per-root limit. Pair/context limits therefore bounded
these runs before that input ceiling became relevant. There were 11, eight and
18 pair repair attempts respectively; coverage's two exhausted pairs required
the checkpoint recovery described below.

The economy configuration consumes about 25% fewer tokens than the reference.
It changes retrieval limits, pair limits and evidence length together; this
does not isolate the causal effect of any single parameter. There is one live
pass per configuration. Model variability and batch context can change decisions
even when a candidate is retrieved in both passes. Inspection of four newly
isolated economy notes confirmed that their former counterpart candidates were
retrieved: changed AI judgments or final scores, rather than retrieval omission,
explain those particular differences.

The coverage pass has completed note matching: 148 relations, 24/26 expected
root pairs, no forbidden/nonconceptual links, and 26 isolated notes. Remote note
reranking consumes 328,360 reported tokens, versus 203,388 for economy (about
61% more). Its additional M1/M3 pair was already retrieved in both directions
by economy and reference. Coverage gave the two accepted note links AI scores
of 0.95 and 0.90, versus economy's best 0.75 and 0.80; the unchanged final floor
therefore rejected them in economy. This particular gain cannot be attributed
to recovering a missing retrieval candidate.

Raising the source importance floor from 0.80 to 0.85 in a replay of recorded
training results retains all 26 expected source pairs in all three passes:
reference relations fall from 102 to 65, economy from 88 to 62, and coverage from
130 to 72. A floor of 0.875 loses one expected pair in reference/economy and two
in coverage. This replay only filters observed output; it
does not simulate new discovery, changed ordering or generation at another
floor. The frozen floor was subsequently executed on unseen sources.

Some retained cross-domain relations are concrete: independent measurement
references connect to detector calibration, and acoustic bypass paths connect
to water bypassing a barrier. Others remain broad, such as links between an
acoustic measurement and correlated sensor errors. A score threshold alone
does not establish their usefulness to a particular reader.

Offline note-score replays also expose a tradeoff: lowering the final floor
from 0.60 to 0.55 increases expected-pair coverage, but admits connections to
some descriptive-only notes (two reference and three economy relations).
Increasing it to 0.65 loses many expected pairs. These replays reuse recorded
candidate judgments and cannot reproduce the effects of changed persistence,
later candidate ordering or another model response. They support retaining
0.60 as a conservative candidate, not claiming that every nearby score has
been exhaustively tested.

## Frozen selection

Economy is selected with a final note floor of 0.60, mandatory AI reranking,
AI weight 0.40 and minimum AI score 0.65. Its text/vector/graph retrieval limits
are 20/20/10, fused shortlist 20 and graph-only reserve 3. Source matching uses
30 candidates, six pairs per root, two evidence passages per source, 800
characters per passage, a 1,000-character summary and four note relations per
pair. Source importance is raised to 0.85; confidence stays 0.80. Weak generic
types remain disabled. Identity/type thresholds stay at 0.92; these are
preserved safeguards, not independently optimized values from this comparison.

Economy used 24.95% fewer reported tokens than reference and 45.41% fewer than
coverage in these live passes. Its 0.85 replay preserves all expected source
pairs with fewer relations than the other passes. The frozen training graph
contains 139 note relations and 62 source relations. Selection and restoration
verified stable IDs and unchanged canonical extraction after a full backup.
Exact parameters are in `matching-benchmark-settings.json`; the original pilot
values remain in `matching-pilot-settings.json`.

The freeze is tied to SHA-256
`bf2b731a77b6f43f287b03fba9f74dd9a241bba6fad798d9fe71ae6672be56cd`
of the raw economy training snapshot. It preceded importing all 20 held-out
sources. No tuning is permitted using their outcome.

## Held-out validation

All 20 new sources completed extraction, note matching and source matching
without failed checkpoints or manual recovery. The final library contains 60
roots, 82 records, 150 notes, 196 note relations and 97 source relations. The
validation added 30 notes, 57 note relations and 35 source relations to the
restored training graph. The original profiles and frozen matching values were
verified unchanged, and temporary diagnostics were restored to disabled.

| Screening measure | Note matching | Source matching |
| --- | ---: | ---: |
| Expected root pairs connected | 27/28 | 27/28 |
| Explicitly forbidden pair violations | 0/35 | 0/35 |
| Connections involving designated nonconceptual sources | 0 | 0 |
| New relations | 57 | 35 |

The missing cases differ: notes do not link P03/V01 (limits under pressure and
retrieval practice), while source matching does not persist P09/V03 (clay crack
diagnosis and drying/heating damage). Their union covers all 28 expected pairs,
but neither layer individually achieves complete coverage. Every expected
source pair was evaluated, including P09/V03: the model returned two proposals
for that pair, neither of which passed persistence criteria. It was not omitted
by the six-pair allowance. Rejected source scores are not retained, so the
specific acceptance gate cannot be reconstructed from the snapshot alone.

The 35 source relations include 31 within labelled expected pairs and four
unlabelled bridges. Their explanations connect transport bypass paths,
versioning/cache history, bounded time guarantees and limits of indirect
observations. Some are broader analogies and still require reader judgment;
they are not silently counted as either correct or incorrect. The 57 note
relations contain 54 in expected pairs and three within individual sources.

Ten designated negative sources remain disconnected at both levels. Four of
them nevertheless produced 12 descriptive notes: Q6=4, R6=5, V05=2 and V06=1.
All 12 are isolated; the other 18 new notes have at least one connection. This
confirms useful matching restraint while exposing remaining extraction waste.
The new Marina Lopes singer example reused the existing singer identity and
stayed separate from the translator; the earlier translator split remains.

Validation used 380,195 reported tokens: 135,798 for preparation and embedding
warm-up, 54,087 for note matching including local embeddings, and 190,310 for
source matching. Source matching made 121 calls for 120 pair decisions, with
one successful repair. Its highest per-root reported input was 10,436 tokens,
below the 60,000 input ceiling. All 20 roots reached their six-pair allowance;
the UI's partial-coverage notice denotes remaining candidates, not an exhausted
global token budget or an unfinished scheduled stage.

Total new benchmark usage is **3,601,186 reported tokens**, including
preparation, all three comparisons, rejected responses, recovery and validation,
against the 5,000,000 ceiling. Two earlier interrupted calls have unknown usage;
validation has none. No additional matching pass was run after validation and
the held-out result was not used to revise settings.

## Known extraction and identity limitations

Six tuning documents intended to yield no conceptual notes produced 18 mostly
descriptive notes. Those notes received no note-matching relations in any
tuning pass, but extraction and candidate evaluation still incurred work.
Extraction prompts remain fixed during this comparison; the benchmark does not
claim this issue is solved. The held-out examples confirm that it remains.

The two fictional Ana Costa identities remain separate while the botanist is
reused across her chapters. Marina Lopes the translator is split across two
identities, while the singer remains separate. The extracted identity facts
lose relevant context in one chapter, which is a plausible explanation for the
missed reuse; a threshold defect has not been established. Entity/type matching
parameters remain fixed across these passes and are not numerically calibrated
by this experiment.

## Runtime corrections and verification

Preparation exposed two recovery/reuse issues. A successful, current zero-note
generation or noncontent summary now qualifies for reuse with its completed
configured checkpoint; failed, unconfigured or changed-content attempts do not.
Generation-only plans now participate in collective note matching only when
the atomic-note-matching stage was actually requested. Interrupted preparation
was recovered through normal checkpoints and job retry eligibility. A later
remote note-reranking termination was retried without accepting unvalidated
relations. Coverage also rejected initial and repair outputs for Q2/P06 and
L3/L1. Later reciprocal source processing produced valid decisions for those
same fingerprints. Normal eligible job retries reused those decisions and
finished the remaining pairs without resetting attempts, budgets or completed
work. All 51 matching checkpoints then completed. All known consumption,
including rejected responses and recovery, remains in the experiment totals.

Verification completed during this work: 501 tests across 82 files, workspace
type checking and build, plus an isolated PostgreSQL benchmark verifier covering
artifact reuse, guarded reset, stable-ID restoration, invalid-restore rollback
and reviewed-relation protection. The broader matching implementation also
updates AI/knowledge, source-ingestion and jobs/processing rules. No database
migration or dependency addition is required.

## Reproduction artifacts

The corpus is versioned in `scripts/fixtures/matching-benchmark.json`; the
workflow is documented in `matching-benchmark.md`. Local
`.cache/matching-benchmark/` phase directories contain raw snapshots, settings,
candidate diagnostics, source decisions, usage and offline analyses. The
manifest records phase completion and postcondition verification. Local
`observations.md` records recovery details and qualitative inspection.
