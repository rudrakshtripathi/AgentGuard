#!/usr/bin/env node
// Python tooling for the prompt-injection classifier.
//   node scripts/ml.mjs setup  -> creates ml/.venv and installs ml/requirements.txt
//   node scripts/ml.mjs train  -> regenerates the dataset, trains TF-IDF + LogisticRegression,
//                                 exports the model to apps/api/models/injection-model.json
// Python is only needed to (re)train. The trained model artifact is committed, so the
// API runs without Python.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { rootDir, isWindows } from './lib/env.mjs';

const venv = resolve(rootDir, 'ml', '.venv');
const venvPython = resolve(venv, isWindows ? 'Scripts/python.exe' : 'bin/python');

function run(cmd, args) {
  console.log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: rootDir });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function systemPython() {
  for (const candidate of isWindows ? ['py', 'python'] : ['python3', 'python']) {
    const r = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (r.status === 0) return candidate;
  }
  console.error('Python 3.10+ is required to train the classifier (https://www.python.org/downloads/).');
  process.exit(1);
}

const command = process.argv[2];
if (command === 'setup') {
  if (!existsSync(venvPython)) run(systemPython(), ['-m', 'venv', venv]);
  run(venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', resolve(rootDir, 'ml', 'requirements.txt')]);
} else if (command === 'train') {
  if (!existsSync(venvPython)) {
    console.error('ml/.venv not found. Run `npm run ml:setup` first.');
    process.exit(1);
  }
  run(venvPython, ['-I', resolve(rootDir, 'ml', 'generate_dataset.py')]);
  run(venvPython, ['-I', resolve(rootDir, 'ml', 'train.py')]);
} else {
  console.error('usage: node scripts/ml.mjs <setup|train>');
  process.exit(1);
}
