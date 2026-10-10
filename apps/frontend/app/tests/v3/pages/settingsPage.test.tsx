import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18n from 'i18next';
import {
  renderSettings,
  SETTINGS_KEYS,
  SETTINGS_USER,
  settledSettings,
} from '../helpers/render-settings';

const SKELETON = 'h-3 w-40';
const count = (html: string, needle: string) => html.split(needle).length - 1;

/**
 * SC-1670: Settings is a list of areas, each at `/settings/<area>`. These
 * render the phone surface, which is what a static render resolves to.
 */
describe('the Settings list', () => {
  test('is the page on a phone: one heading, no area and no form mounted behind it', () => {
    const html = renderSettings('/settings', { answered: settledSettings() });
    expect(count(html, '<h1')).toBe(1);
    expect(html).toContain('>Settings</h1>');
    expect(html).not.toContain('<section');
    expect(html).not.toContain('sections of');
    expect(html).not.toContain('aria-current');
  });

  test('each row says what the area holds now', () => {
    const html = renderSettings('/settings', { answered: settledSettings() });
    expect(html).toContain('Ivy Calder · GBP · Section 104');
    expect(html).toContain('2 devices');
    expect(html).toContain('No backup yet');
    expect(html).toContain(SETTINGS_USER.email);
    expect(html).not.toContain(SKELETON);
  });

  test('a row holds its place while its read is open', () => {
    const answered = settledSettings().filter(([key]) => key !== SETTINGS_KEYS.backup);
    expect(renderSettings('/settings', { answered })).toContain(SKELETON);
  });

  test('a read that failed leaves the row without a value, never a placeholder for good', () => {
    const answered = settledSettings().filter(([key]) => key !== SETTINGS_KEYS.backup);
    const html = renderSettings('/settings', { answered, failed: [SETTINGS_KEYS.backup] });
    expect(html).toContain('Your data');
    expect(html).not.toContain('No backup yet');
    expect(html).not.toContain(SKELETON);
  });

  test('names no currency until the real one is known', () => {
    const answered = settledSettings().filter(([key]) => key !== SETTINGS_KEYS.baseCurrency);
    const html = renderSettings('/settings', { answered, failed: [SETTINGS_KEYS.baseCurrency] });
    expect(html).toContain('Ivy Calder · Section 104');
    expect(html).not.toContain('USD');
  });

  test('says nothing about reminders until this device has been asked', () => {
    const html = renderSettings('/settings', { answered: settledSettings() });
    expect(html).not.toContain('Reminders');
  });
});

describe('the AI agents area', () => {
  test('is not listed while access is off and nothing is connected', () => {
    expect(renderSettings('/settings', { answered: settledSettings() })).not.toContain('AI agents');
  });

  test('stays listed with access off while an app is still connected, so it can be cut off', () => {
    const answered = settledSettings().map(([key, data]): [typeof key, unknown] =>
      key === SETTINGS_KEYS.connectedApps
        ? [key, [{ clientId: 'c1', name: 'Reader', connectedAt: '2026-10-01T00:00:00.000Z' }]]
        : [key, data]
    );
    expect(renderSettings('/settings', { answered })).toContain('AI agents');
    const area = renderSettings('/settings/agents', { answered });
    expect(area).toContain('Reader');
    expect(area).not.toContain('AI agent access is not on');
  });

  test('says access is off rather than showing a title over nothing', () => {
    const html = renderSettings('/settings/agents', { answered: settledSettings() });
    expect(html).toContain('AI agent access is not on for this account.');
  });

  test('counts the keys while access is on', () => {
    const answered = settledSettings().map(([key, data]): [typeof key, unknown] =>
      key === SETTINGS_KEYS.agentAccess ? [key, { enabled: true }] : [key, data]
    );
    answered.push([SETTINGS_KEYS.agentKeys, [{ id: 'k1' }]]);
    expect(renderSettings('/settings', { answered })).toContain('1 agent key');
  });
});

describe('a Settings area', () => {
  test('is the page on a phone: its title is the heading and the list is not mounted', () => {
    const html = renderSettings('/settings/data', { answered: settledSettings() });
    expect(count(html, '<h1')).toBe(1);
    expect(html).toMatch(/<h1[^>]*>Your data<\/h1>/);
    expect(html).toContain('sections of data');
    expect(html).not.toContain('<nav');
    expect(html).toContain('href="/settings"');
  });

  test('an address that is no area shows the list and says so, with no row marked current', () => {
    const html = renderSettings('/settings/bogus', { answered: settledSettings() });
    expect(html).toContain('There is no such settings page.');
    expect(html).toContain('<nav');
    expect(count(html, '<h1')).toBe(1);
    expect(html).not.toContain('aria-current');
  });
});

describe('the area table', () => {
  const source = readFileSync(
    resolve(import.meta.dir, '../../../src/v3/pages/SettingsPage.tsx'),
    'utf8'
  );

  test('lists the areas in the order a person reaches for them', () => {
    const ids = [...source.matchAll(/^\s+id: '([a-z]+)',$/gm)].map((match) => match[1]);
    expect(ids).toEqual(['you', 'notifications', 'agents', 'data', 'account']);
  });

  test('every area is titled by a key that exists', () => {
    const keys = [...source.matchAll(/titleKey: '([^']+)'/g)].map((match) => match[1] ?? '');
    expect(keys.length).toBe(5);
    for (const key of keys) expect(i18n.exists(key)).toBe(true);
  });
});
