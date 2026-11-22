const PRIVATE_KEY_BLOCK = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i;
const API_TOKEN = /\b(?:sk[-_](?:live[-_])?|gh[pousr]_|xox[baprs]-|AIza)[A-Za-z0-9_-]{16,}|\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/i;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/;
const CREDENTIAL_ASSIGNMENT = /\b(?:password|secret|token)\s*[:=]\s*[^\s,;]+/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?:\+?\d[\d().\s-]{7,}\d)/g;
const CARD_CANDIDATE = /(?:\d[ -]?){13,19}/g;

export type SensitiveDataKind =
  | 'api_key_token'
  | 'high_entropy_token'
  | 'private_key_block'
  | 'credit_card'
  | 'credential_assignment'
  | 'aws_access_key'
  | 'email_list'
  | 'phone_list';

function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function hasHighEntropyToken(text: string): boolean {
  return text.split(/\s+/).some((part) => {
    const token = part.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
    if (token.length < 32 || !/^[A-Za-z0-9_+/=-]+$/.test(token)) return false;
    const frequencies = new Map<string, number>();
    for (const ch of token) frequencies.set(ch, (frequencies.get(ch) ?? 0) + 1);
    const entropy = [...frequencies.values()].reduce((sum, count) => {
      const probability = count / token.length;
      return sum - probability * Math.log2(probability);
    }, 0);
    return entropy >= 3.5;
  });
}

/** Returns only sensitive-data kinds; secret values are never included in the result. */
export function scanSensitiveData(text: string): SensitiveDataKind[] {
  const kinds: SensitiveDataKind[] = [];
  const add = (kind: SensitiveDataKind) => { if (!kinds.includes(kind)) kinds.push(kind); };

  if (API_TOKEN.test(text)) add('api_key_token');
  API_TOKEN.lastIndex = 0;
  if (AWS_ACCESS_KEY.test(text)) add('aws_access_key');
  if (PRIVATE_KEY_BLOCK.test(text)) add('private_key_block');
  if (CREDENTIAL_ASSIGNMENT.test(text)) add('credential_assignment');
  if (hasHighEntropyToken(text)) add('high_entropy_token');
  if ([...text.matchAll(CARD_CANDIDATE)].some(([candidate]) => passesLuhn(candidate))) add('credit_card');
  if ([...text.matchAll(EMAIL)].length >= 5) add('email_list');
  const phones = [...text.matchAll(PHONE)].map(([candidate]) => candidate).filter((candidate) => {
    const digits = candidate.replace(/\D/g, '');
    return digits.length >= 10 && digits.length <= 15 && !passesLuhn(candidate);
  });
  if (phones.length >= 5) add('phone_list');
  return kinds;
}
