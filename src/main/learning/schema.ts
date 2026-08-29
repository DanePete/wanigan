/**
 * Schema ownership stays in main/db.ts so every table exists before a feature
 * runs. This list is exported as an integration/test assertion and deliberately
 * contains no migration side effect.
 */
export const REQUIRED_LEARNING_TABLES = [
  'learning_signals',
  'knowledge_items',
  'knowledge_versions',
  'knowledge_candidates',
  'knowledge_evidence',
  'knowledge_relations',
  'knowledge_projections',
  'learning_experiments',
  'artifact_metrics',
  'knowledge_fts',
] as const;

export type LearningTable = (typeof REQUIRED_LEARNING_TABLES)[number];
