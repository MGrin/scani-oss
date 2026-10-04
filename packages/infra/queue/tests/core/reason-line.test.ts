import { describe, expect, test } from 'bun:test';
import { reasonLine } from '../../src/core/reason-line';

const REASON_MAX_CHARS = 240;

describe('reasonLine', () => {
  test('a pretty-printed body reads through to its message', () => {
    const reason = [
      'ai-openai HTTP 400: {',
      '  "error": {',
      '    "message": "The uploaded file could not be processed. Please try again with a different file.",',
      '    "type": "invalid_request_error"',
      '  }',
      '}',
    ].join('\n');

    expect(reasonLine(reason)).toBe(
      'ai-openai HTTP 400: { "error": { "message": "The uploaded file could not be processed. Please try again with a different file.", "type": "invalid_request_error" } }'
    );
  });

  test('tabs, carriage returns and edge whitespace collapse too', () => {
    expect(reasonLine('  boom\r\n\tat   somewhere\n')).toBe('boom at somewhere');
  });

  test('a long reason is capped, and says it was cut', () => {
    const line = reasonLine(`timeout ${'x'.repeat(REASON_MAX_CHARS * 2)}`);

    expect(line).toHaveLength(REASON_MAX_CHARS);
    expect(line.startsWith('timeout xxx')).toBe(true);
    expect(line.endsWith('…')).toBe(true);
  });

  test('a reason at the cap is left whole', () => {
    const exact = 'y'.repeat(REASON_MAX_CHARS);

    expect(reasonLine(exact)).toBe(exact);
  });

  test('no reason is an empty line', () => {
    expect(reasonLine(null)).toBe('');
    expect(reasonLine(' \n ')).toBe('');
  });
});
