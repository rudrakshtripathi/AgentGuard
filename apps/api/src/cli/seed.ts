import { runSeed } from './seedRunner.js';
import { fail } from './common.js';

await runSeed().catch(fail);
