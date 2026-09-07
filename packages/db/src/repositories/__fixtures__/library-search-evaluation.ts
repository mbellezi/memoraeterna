export interface LibrarySearchEvaluationCase {
  query: string;
  candidate: string;
  embeddingScore: number;
  corroborated: boolean;
  expectedRelevant: boolean;
}

// Synthetic, versioned calibration cases. Real-library corpora stay local and private.
export const librarySearchEvaluationCases: LibrarySearchEvaluationCase[] = [
  { query: "Dean Radin", candidate: "Court staffing proposal", embeddingScore: 0.32, corroborated: false, expectedRelevant: false },
  { query: "Dean Radin", candidate: "Anomalous cognition review", embeddingScore: 0.44, corroborated: true, expectedRelevant: true },
  { query: "remote viewing", candidate: "Police intelligence report", embeddingScore: 0.29, corroborated: false, expectedRelevant: false },
  { query: "remote viewing", candidate: "Parapsychology methods", embeddingScore: 0.56, corroborated: false, expectedRelevant: true },
  { query: "Alexandre de Moraes", candidate: "Supreme court investigation", embeddingScore: 0.45, corroborated: true, expectedRelevant: true },
  { query: "Alexandre de Moraes", candidate: "Poetry criticism", embeddingScore: 0.31, corroborated: false, expectedRelevant: false },
  { query: "photosynthesis", candidate: "Plant energy conversion", embeddingScore: 0.61, corroborated: false, expectedRelevant: true },
  { query: "photosynthesis", candidate: "Quantum consciousness", embeddingScore: 0.35, corroborated: false, expectedRelevant: false },
  { query: "Murilo Mendes", candidate: "Dialectical lyricism", embeddingScore: 0.43, corroborated: true, expectedRelevant: true },
  { query: "Murilo Mendes", candidate: "Bank regulation", embeddingScore: 0.27, corroborated: false, expectedRelevant: false },
  { query: "global consciousness project", candidate: "Random number generator experiments", embeddingScore: 0.58, corroborated: false, expectedRelevant: true },
  { query: "global consciousness project", candidate: "Government transparency portal", embeddingScore: 0.38, corroborated: false, expectedRelevant: false },
  { query: "Carl Jung synchronicity", candidate: "Analytical psychology overview", embeddingScore: 0.52, corroborated: false, expectedRelevant: true },
  { query: "Carl Jung synchronicity", candidate: "Cabinet appointments", embeddingScore: 0.33, corroborated: false, expectedRelevant: false },
  { query: "Banco Master", candidate: "Financial investigation", embeddingScore: 0.46, corroborated: true, expectedRelevant: true },
  { query: "Banco Master", candidate: "Consciousness bibliography", embeddingScore: 0.37, corroborated: false, expectedRelevant: false },
  { query: "precognition", candidate: "Presentiment experiments", embeddingScore: 0.49, corroborated: false, expectedRelevant: true },
  { query: "precognition", candidate: "Judicial procedure", embeddingScore: 0.39, corroborated: false, expectedRelevant: false },
  { query: "epistemology", candidate: "Philosophy of knowledge", embeddingScore: 0.47, corroborated: true, expectedRelevant: true },
  { query: "epistemology", candidate: "Daily sports results", embeddingScore: 0.22, corroborated: false, expectedRelevant: false },
  { query: "police officers in court chambers", candidate: "Court staffing rules", embeddingScore: 0.54, corroborated: false, expectedRelevant: true },
  { query: "police officers in court chambers", candidate: "Poetic imagery", embeddingScore: 0.34, corroborated: false, expectedRelevant: false },
  { query: "scientific anomalies", candidate: "Anomalous phenomena taxonomy", embeddingScore: 0.46, corroborated: true, expectedRelevant: true },
  { query: "scientific anomalies", candidate: "Procurement notice", embeddingScore: 0.3, corroborated: false, expectedRelevant: false },
  { query: "physicalism reductionism", candidate: "Philosophy of mind introduction", embeddingScore: 0.64, corroborated: false, expectedRelevant: true },
  { query: "physicalism reductionism", candidate: "Federal police staffing", embeddingScore: 0.36, corroborated: false, expectedRelevant: false },
  { query: "RNG experiments", candidate: "Random event generator study", embeddingScore: 0.42, corroborated: true, expectedRelevant: true },
  { query: "RNG experiments", candidate: "Literary elements essay", embeddingScore: 0.28, corroborated: false, expectedRelevant: false },
  { query: "unknown person name", candidate: "Generic people-heavy news article", embeddingScore: 0.41, corroborated: false, expectedRelevant: false },
  { query: "unknown person name", candidate: "Biography with exact entity", embeddingScore: 0.4, corroborated: true, expectedRelevant: true }
];
