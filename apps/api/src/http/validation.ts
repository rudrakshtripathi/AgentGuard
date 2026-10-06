import { z } from 'zod';
import { badRequest } from './errors.js';
import { CALL_STATUSES } from '../queries/toolCalls.js';

/** Centralised server-side validation: the real validation boundary (TRD §5, §9). */

const MAX_DEPTH = 20;

/**
 * Agent-supplied JSON must be storable as jsonb and safe to hash/render:
 * no NUL characters, no lone UTF-16 surrogates, bounded nesting.
 */
export function assertJsonSafe(value: unknown, path = 'params', depth = 0): void {
  if (depth > MAX_DEPTH) throw badRequest(`${path} is nested too deeply (max ${MAX_DEPTH} levels).`);
  if (typeof value === 'string') {
    if (value.includes('\u0000') || !value.isWellFormed()) throw badRequest(`${path} contains invalid characters (NUL or unpaired surrogate).`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJsonSafe(v, `${path}[${i}]`, depth + 1));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assertJsonSafe(k, `${path} key`, depth + 1);
      assertJsonSafe(v, `${path}.${k}`, depth + 1);
    }
  }
}

const plainObject = z.custom<Record<string, unknown>>((v) => typeof v === 'object' && v !== null && !Array.isArray(v), {
  message: 'params must be a JSON object',
});

export const toolCallBody = z
  .object({
    tool_name: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_.:-]+$/, 'tool_name may contain only letters, digits, and _ . : -'),
    params: plainObject,
    requested_at: z.iso.datetime({ offset: true }).optional(),
    wait_for_approval: z.boolean().optional(),
  })
  .strict();

export const loginBody = z
  .object({
    username: z.string().trim().min(1, 'Username is required').max(100),
    password: z.string().min(1, 'Password is required').max(200),
  })
  .strict();

export const decideBody = z.object({ decision: z.enum(['approve', 'reject']) }).strict();

export const uuidParam = z.uuid({ message: 'id must be a valid UUID' });

const page = z.coerce.number().int().min(1).max(100_000).default(1);
const pageSize = z.coerce.number().int().min(1).max(200).default(25);

export const listCallsQuery = z
  .object({
    status: z.enum(CALL_STATUSES).optional(),
    date_from: z.iso.datetime({ offset: true }).optional(),
    date_to: z.iso.datetime({ offset: true }).optional(),
    page,
    page_size: pageSize,
  })
  .strict()
  .refine((q) => !q.date_from || !q.date_to || new Date(q.date_from) <= new Date(q.date_to), {
    message: 'date_from must be before date_to',
  });

export const listAuditQuery = z
  .object({
    event_type: z.string().max(100).optional(),
    call_id: z.uuid().optional(),
    focus_seq: z.coerce.number().int().min(1).optional(),
    page,
    page_size: pageSize,
  })
  .strict();

export const statsQuery = z.object({ range: z.enum(['24h', '7d']).default('24h') }).strict();

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
    throw badRequest(issues.map((i) => (i.path === '(root)' ? i.message : `${i.path}: ${i.message}`)).join('; '), { issues });
  }
  return result.data;
}
