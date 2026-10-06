import { readFileSync } from 'node:fs';

/**
 * Prompt-injection classifier inference (FR-003): TF-IDF (word 1-2 grams, l2) +
 * logistic regression, trained in Python by ml/train.py and exported as JSON.
 * This file re-implements sklearn's transform + predict_proba exactly; the parity
 * test (test/unit/injectionClassifier.test.ts) checks it against sklearn's outputs.
 *
 * Demonstration-scale model: see ml/model/metrics.json for its (limited) accuracy.
 */

interface ModelFile {
  format: string;
  vectorizer: {
    lowercase: boolean;
    token_pattern: string;
    ngram_range: [number, number];
    norm: 'l2';
    sublinear_tf: boolean;
    vocabulary: Record<string, number>;
    idf: number[];
  };
  classifier: { coef: number[]; intercept: number };
  metrics?: unknown;
}

export interface InjectionClassifier {
  /** Probability (0..1) that the text is an injection attempt. */
  predictProbability(text: string): number;
  readonly featureCount: number;
}

// Mirrors Python's (?u)\b\w\w+\b: maximal runs of Unicode word characters, length >= 2.
const TOKEN = /[\p{L}\p{N}_]{2,}/gu;

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN) ?? [];
}

export function loadClassifier(modelPath: string): InjectionClassifier {
  let raw: string;
  try {
    raw = readFileSync(modelPath, 'utf8');
  } catch {
    throw new Error(
      `Injection classifier model not found at ${modelPath}. Train it with \`npm run ml:setup && npm run ml:train\` ` +
        '(or restore apps/api/models/injection-model.json from git).',
    );
  }
  const model = JSON.parse(raw) as ModelFile;
  if (model.format !== 'agentguard-tfidf-logreg-v1') throw new Error(`Unsupported classifier model format: ${model.format}`);
  const { vocabulary, idf, ngram_range } = model.vectorizer;
  const { coef, intercept } = model.classifier;
  const vocab = new Map(Object.entries(vocabulary));
  if (idf.length !== coef.length || vocab.size !== idf.length) throw new Error('Corrupt classifier model: dimension mismatch');
  const [minN, maxN] = ngram_range;

  return {
    featureCount: idf.length,
    predictProbability(text: string): number {
      const tokens = tokenize(text);
      const counts = new Map<number, number>();
      for (let n = minN; n <= maxN; n++) {
        for (let i = 0; i + n <= tokens.length; i++) {
          const index = vocab.get(tokens.slice(i, i + n).join(' '));
          if (index !== undefined) counts.set(index, (counts.get(index) ?? 0) + 1);
        }
      }
      let norm = 0;
      const weights: [number, number][] = [];
      for (const [index, tf] of counts) {
        const w = tf * idf[index]!;
        weights.push([index, w]);
        norm += w * w;
      }
      norm = Math.sqrt(norm);
      let z = intercept;
      if (norm > 0) for (const [index, w] of weights) z += (w / norm) * coef[index]!;
      return 1 / (1 + Math.exp(-z));
    },
  };
}

/**
 * Collects the free-text content of tool params (string values, recursively). Object keys
 * are visited in sorted order so the score does not depend on key order (Postgres jsonb
 * reorders keys, and the same call must score identically when re-read).
 */
export function extractText(params: unknown, depth = 0): string[] {
  if (depth > 8 || params === null || params === undefined) return [];
  if (typeof params === 'string') return [params];
  if (Array.isArray(params)) return params.flatMap((v) => extractText(v, depth + 1));
  if (typeof params === 'object') {
    const obj = params as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .flatMap((k) => extractText(obj[k], depth + 1));
  }
  return [];
}

export type InjectionStatus = 'scored' | 'skipped' | 'unavailable';

export interface InjectionResult {
  /** 0-100, or null when classification was skipped or unavailable (never a fake 0). */
  injection_score: number | null;
  status: InjectionStatus;
  detail: string;
}

/** Scores params; "skipped" for no meaningful text, "unavailable" if the model failed. */
export function scoreInjection(classifier: InjectionClassifier | null, params: unknown): InjectionResult {
  const text = extractText(params).join('\n');
  if (text.replace(/\s/g, '').length < 3) {
    return { injection_score: null, status: 'skipped', detail: 'No free text in params; classification skipped.' };
  }
  if (!classifier) {
    return { injection_score: null, status: 'unavailable', detail: 'Classifier unavailable; treated as high uncertainty.' };
  }
  try {
    const p = classifier.predictProbability(text);
    if (!Number.isFinite(p)) throw new Error('non-finite probability');
    return {
      injection_score: Math.round(p * 10_000) / 100,
      status: 'scored',
      detail: `TF-IDF + logistic regression: P(injection) = ${p.toFixed(4)}`,
    };
  } catch (err) {
    return { injection_score: null, status: 'unavailable', detail: `Classifier error: ${(err as Error).message}` };
  }
}
