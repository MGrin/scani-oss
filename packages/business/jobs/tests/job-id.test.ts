import { describe, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodTypeAny } from 'zod';
import * as userJobs from '../src/user-jobs';

/**
 * SC-1710. BullMQ 6.3.12 refuses a custom job id holding `:` unless it splits
 * into exactly three parts, and every descriptor folds payload values into its
 * id. The scheduled exchange sync passed its own repeatable job id
 * (`repeat:<key>:<time>`) inside a requestId, so every scheduled import was
 * refused at enqueue. No payload value may be able to put a colon in an id.
 */

type Descriptor = {
  name: string;
  schema: ZodTypeAny;
  computeJobId: (data: unknown) => string;
};

const descriptors = Object.values(userJobs as Record<string, unknown>).filter(
  (value): value is Descriptor =>
    typeof value === 'object' &&
    value !== null &&
    'computeJobId' in value &&
    'schema' in value &&
    'name' in value
);

// Three colons, so BullMQ's three-part exception cannot pass it by accident.
const COLONS = 'a:b:c:d';

/** A payload for `schema` whose every string carries `str`. Shape only: nothing is validated. */
function sample(schema: ZodTypeAny, str: string): unknown {
  const def = schema._def as { typeName: string } & Record<string, unknown>;
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as unknown as { shape: Record<string, ZodTypeAny> }).shape;
      return Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, sample(v, str)]));
    }
    case 'ZodString':
      return str;
    case 'ZodNumber':
      return 1;
    case 'ZodBoolean':
      return true;
    case 'ZodDate':
      return new Date('2026-10-11T00:00:00Z');
    case 'ZodLiteral':
      return def.value;
    case 'ZodEnum':
      return (def.values as string[])[0];
    case 'ZodNativeEnum':
      return Object.values(def.values as Record<string, unknown>)[0];
    case 'ZodArray':
      return [sample(def.type as ZodTypeAny, str)];
    case 'ZodRecord':
      return { [str]: sample(def.valueType as ZodTypeAny, str) };
    case 'ZodOptional':
    case 'ZodNullable':
      return sample(def.innerType as ZodTypeAny, str);
    case 'ZodDefault':
      return sample(def.innerType as ZodTypeAny, str);
    case 'ZodEffects':
      return sample(def.schema as ZodTypeAny, str);
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      return sample((def.options as ZodTypeAny[])[0] as ZodTypeAny, str);
    default:
      return str;
  }
}

describe('every user job id is one BullMQ can add (SC-1710)', () => {
  test('the registry is read: one descriptor per file in user-jobs/', () => {
    const files = readdirSync(join(import.meta.dir, '../src/user-jobs')).filter(
      (f) => f.endsWith('.ts') && f !== 'index.ts'
    );
    expect(descriptors.length).toBe(files.length);
    expect(descriptors.map((d) => d.name)).toContain(userJobs.TRANSACTION_IMPORT.name);
  });

  for (const descriptor of descriptors) {
    test(`${descriptor.name}: a payload value holding ":" puts no ":" in the id`, () => {
      const id = descriptor.computeJobId(sample(descriptor.schema, COLONS));
      expect(id).not.toContain(':');
    });

    test(`${descriptor.name}: payloads differing only by the escaped character keep different ids`, () => {
      const withColon = descriptor.computeJobId(sample(descriptor.schema, 'x:y'));
      const without = descriptor.computeJobId(sample(descriptor.schema, 'x-y'));
      expect(withColon).not.toBe(without);
    });
  }

  test('CONTROL: an id with no colon in it is unchanged, so in-flight jobs still dedup', () => {
    expect(
      userJobs.TRANSACTION_IMPORT.computeJobId({
        userId: 'u1',
        requestId: 'r1',
        accountId: '00000000-0000-0000-0000-000000000001',
        source: 'etherscan',
      })
    ).toBe('transaction-import_u1_00000000-0000-0000-0000-000000000001_etherscan_r1');
  });

  test('the scheduled sync shape: a repeatable job id inside a requestId', () => {
    const id = userJobs.TRANSACTION_IMPORT.computeJobId({
      userId: 'u1',
      requestId: 'repeat:exchange-transactions:1791695100000:00000000-0000-0000-0000-000000000001',
      accountId: '00000000-0000-0000-0000-000000000001',
      source: 'bybit',
    });
    expect(id).not.toContain(':');
  });
});
