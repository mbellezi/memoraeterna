/**
 * Synthetic note text for the DEV lane probe (F3 B5, T47b): twelve fictional notes of four
 * sentences each. A probe prompt carries ten of them, about as much text as a relation decision
 * about two notes with their neighbours (1.3k tokens). Nothing here comes from a real library.
 */
export interface LaneProbeNote {
  title: string;
  sentences: readonly [string, string, string, string];
}

export const laneProbeNotes: readonly LaneProbeNote[] = [
  {
    title: "The Brannock Valley seed library",
    sentences: [
      "The Brannock Valley seed library lends packets of heirloom beans, squash and flax to any resident with a library card.",
      "Borrowers return part of the next harvest's seed, labelled with the planting date and the field it came from.",
      "Volunteers test germination every autumn and discard any batch that sprouts in fewer than seven of ten seeds.",
      "Lending rose sharply after the flood of 2019, when several farms lost their own seed stock."
    ]
  },
  {
    title: "The Marlow harbour tide clock",
    sentences: [
      "The harbour tide clock in Marlow shows the next high water by moving a copper hand across a carved slate dial.",
      "Its gears were cut by a clockmaker who corrected for the moon using a table copied from a ferry captain's notebook.",
      "Fishing crews read it before dawn and plan their departure around the hour when the channel is deepest.",
      "The council repaints the dial every spring, but the original numerals have been traced by hand each time."
    ]
  },
  {
    title: "Quiet hours in the reading room",
    sentences: [
      "The reading room of the old customs house keeps quiet hours between nine and noon, announced by a small brass bell.",
      "Regular visitors say the silence changed the way they take notes, from long summaries to single careful questions.",
      "A volunteer logs how many people stay past the bell, and the number has doubled since the heating was fixed.",
      "Plans for a second reading room were dropped when the committee realised the first one was rarely full."
    ]
  },
  {
    title: "Bridge inspections on the Aldermoor line",
    sentences: [
      "Inspectors on the Aldermoor line check each of the forty-one bridges for hairline cracks every second winter.",
      "They tap the stonework with a small hammer and listen for a dull note that points to water trapped behind the facing.",
      "Reports are filed with a photograph of the same spot taken from the same angle at each visit.",
      "The oldest arch has not changed in thirty years, which the inspectors consider the best result possible."
    ]
  },
  {
    title: "A beekeeping schedule for cold springs",
    sentences: [
      "In a cold spring the hives are opened only on the first warm afternoon, and never before the willow catkins appear.",
      "Beekeepers weigh each hive by lifting one side, comparing the effort with last year's marks on the stand.",
      "Sugar syrup is offered only when the stores fall below two frames, to avoid weakening the natural foraging habit.",
      "Notes from the last decade show that colonies fed early produced less honey in June than colonies left alone."
    ]
  },
  {
    title: "Keeping a compost thermometer log",
    sentences: [
      "A long-stemmed thermometer pushed into the middle of the pile shows when the compost has started to heat properly.",
      "Gardeners record the reading at noon and turn the pile whenever it stays above sixty degrees for three days.",
      "A pile that never warms usually lacks nitrogen, and a handful of grass clippings often starts it again.",
      "After two months the log is compared with the finished compost to see which turning schedule worked best."
    ]
  },
  {
    title: "The Penhallow lantern festival",
    sentences: [
      "Each November the town of Penhallow floats paper lanterns down the river to mark the end of the fishing season.",
      "Schoolchildren fold the lanterns in October, and every class chooses a colour that is not used by any other.",
      "The route is lit by volunteers who stand on the bridges and relight any lantern that has drifted to the bank.",
      "Visitors are asked to leave before the last lantern passes the weir so the river is quiet when it sinks."
    ]
  },
  {
    title: "Mapping the Corvin caves",
    sentences: [
      "Cavers mapping the Corvin system measure each passage with a laser distance meter and a handheld compass.",
      "The survey team enters in pairs, and one person always stays within sight of the entrance rope.",
      "A side passage found in March ends in a small chamber where the air moves, which suggests a second opening.",
      "The finished map will be printed at a scale that allows the narrowest crawl to be traced with a finger."
    ]
  },
  {
    title: "Restoring a 1920s printing press",
    sentences: [
      "The cooperative restored a platen press from the 1920s by replacing the worn ink rollers and re-cutting one gear.",
      "Its first job was a run of two hundred invitations, printed in black on cream paper with a hand-set border.",
      "Members take turns learning the feeding rhythm, which is slow at first and then surprisingly fast.",
      "The press now pays for its own oil and paper through a weekly order of cards for the local market."
    ]
  },
  {
    title: "Winter bird counts at the reservoir",
    sentences: [
      "Every January volunteers count the waterfowl on the reservoir from the same six viewing points along the east bank.",
      "Counts are written on waterproof cards and merged the same evening, before anyone can remember a different total.",
      "The number of tufted ducks has fallen for four years while the count of goosanders has slowly climbed.",
      "The group suspects that the new sailing club changes where the birds rest, and plans a quieter second survey."
    ]
  },
  {
    title: "A regional recipe for salted plums",
    sentences: [
      "Salted plums in the northern uplands are packed in stoneware jars with coarse salt and a layer of crushed fennel seed.",
      "The jars are weighted with a flat river stone and kept in a cool cellar for at least six weeks.",
      "Cooks use the brine to season soups, and the plums themselves are sliced thinly over barley and soft cheese.",
      "A family notebook records that the best batch was made in a year when the plums ripened unusually late."
    ]
  },
  {
    title: "Teaching map reading in primary school",
    sentences: [
      "A teacher in the uplands starts map reading with the school playground, drawn first by the children on the ground in chalk.",
      "Only after they can find the gate and the oak tree on their own drawing does she show them a printed map.",
      "Each child then plans a short walk and explains the route to a partner without using the words left or right.",
      "By the end of term most of the class can follow a contour line, and several have begun drawing maps at home."
    ]
  }
];

/** Notes in one probe prompt. */
const notesPerPrompt = 10;

/**
 * The prompt of the probe's call number `index`: a decide-sized request (an instruction, then ten
 * notes, the first two being the pair to judge). The notes rotate with `index`, so no two calls
 * share a prefix a provider could cache, and the text is a function of `index` alone.
 */
export function laneProbePrompt(index: number): string {
  const offset = (index * 5) % laneProbeNotes.length;
  const notes = Array.from(
    { length: notesPerPrompt },
    (_, position) => laneProbeNotes[(offset + position) % laneProbeNotes.length]!
  );
  const labels = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
  return [
    `Probe request ${index + 1}.`,
    "You are checking whether two notes from a personal knowledge library state related ideas.",
    'Decide for Note A and Note B only, and answer with one JSON object: {"related": true or false, "reason": "one short sentence"}.',
    "The other notes are context from the same library and may be ignored.",
    "",
    ...notes.map(
      (note, position) => `Note ${labels[position]} (${note.title}): ${note.sentences.join(" ")}`
    )
  ].join("\n");
}
