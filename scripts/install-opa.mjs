#!/usr/bin/env node
// Downloads the official Open Policy Agent binary into ./tools/bin and verifies
// its SHA-256 against the checksum published alongside the release.
// Skips the download if the expected version is already present.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { rootDir } from './lib/env.mjs';
import { OPA_VERSION, opaBinaryPath } from './lib/opa.mjs';

function assetName() {
  const { platform, arch } = process;
  const a = arch === 'arm64' ? 'arm64' : 'amd64';
  if (platform === 'win32') return 'opa_windows_amd64.exe';
  if (platform === 'darwin') return `opa_darwin_${a}`;
  if (platform === 'linux') return a === 'arm64' ? 'opa_linux_arm64_static' : 'opa_linux_amd64_static';
  throw new Error(`Unsupported platform ${platform}/${arch}; install OPA manually: https://www.openpolicyagent.org/docs/#running-opa`);
}

function installedVersion(bin) {
  try {
    const out = execFileSync(bin, ['version'], { encoding: 'utf8' });
    return /Version:\s*(\S+)/.exec(out)?.[1];
  } catch {
    return undefined;
  }
}

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const bin = opaBinaryPath();
if (existsSync(bin) && installedVersion(bin) === OPA_VERSION) {
  console.log(`[opa] v${OPA_VERSION} already installed at ${bin}`);
  process.exit(0);
}

const asset = assetName();
const base = `https://github.com/open-policy-agent/opa/releases/download/v${OPA_VERSION}`;
console.log(`[opa] downloading ${asset} v${OPA_VERSION}...`);
const [binary, checksumFile] = await Promise.all([download(`${base}/${asset}`), download(`${base}/${asset}.sha256`)]);
const expected = checksumFile.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase();
const actual = createHash('sha256').update(binary).digest('hex');
if (!expected || expected !== actual) {
  console.error(`[opa] checksum mismatch: expected ${expected}, got ${actual}. Refusing to install.`);
  process.exit(1);
}
mkdirSync(resolve(rootDir, 'tools', 'bin'), { recursive: true });
writeFileSync(bin, binary);
if (process.platform !== 'win32') chmodSync(bin, 0o755);
console.log(`[opa] installed ${bin} (sha256 verified): ${installedVersion(bin) ?? 'unknown version'}`);
