// English function words and generic filler for topic-name terms (hand-written for this
// project; no third-party list is copied). Generic words ("first", "known", "based") are here on
// purpose: they are frequent in notes and never name a topic.
export const englishStopwords: readonly string[] =
  `a about above across after afterwards again against all almost alone along already also
although always am among an and another any anyone anything anywhere are around as at be became
because become becomes becoming been before being below beside besides between beyond both but by
called can cannot could did do does doing done down during each either else elsewhere enough even
ever every everyone everything few first five for four from further get gets given had has have
having he her here hers herself him himself his how however i if in include included includes
including indeed instead into is it its itself just keep known last later least less like likely
made make makes many may me meanwhile might more moreover most mostly much must my myself near
neither never new next no nobody none nor not nothing now nowhere of off often on once one only
onto or other others otherwise our ours ourselves out over own per perhaps rather really same
second see seem seemed seems several she should since six so some somehow someone something
sometimes somewhere still such take taken ten than that the their theirs them themselves then
there thereby therefore these they third this those though three through throughout thus to
together too toward towards two under unless until up upon us use used uses using usually various
very via was we well were what whatever when whenever where whereas whether which while whilst who
whoever whole whom whose why will with within without would yet you your yours yourself
yourselves based according especially particularly generally overall specific important
different similar certain common main major part parts way ways thing things example examples
case cases kind kinds type types form forms level levels number numbers set sets general single
simple`.split(/\s+/u);
