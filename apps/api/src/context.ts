import type { Config } from './config.js';
import type { Db } from './db/pool.js';
import type { Logger } from './logger.js';
import type { PolicyClient } from './policy/policyClient.js';
import type { InjectionClassifier } from './scoring/injectionClassifier.js';
import type { ChangeFeed } from './realtime/changeFeed.js';

/** Everything a request handler or service needs; built once in server.ts (or by tests). */
export interface AppContext {
  config: Config;
  db: Db;
  logger: Logger;
  policy: PolicyClient;
  /** null when the model failed to load: scoring then fails toward caution (FR-003). */
  classifier: InjectionClassifier | null;
  classifierError: string | null;
  changeFeed: ChangeFeed | null;
}
