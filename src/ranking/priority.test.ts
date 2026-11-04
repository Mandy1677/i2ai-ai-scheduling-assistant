import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { priorityLabel, rankOf, sortByPriority, type RankableItem } from './priority';

const item = (overrides: Partial<RankableItem> & { sourceKey: string }): RankableItem => ({
  category: null,
  urgentExplicit: false,
  deadline: null,
  receivedAt: '2026-11-01T00:00:00Z',
  ...overrides,
});

describe('priority ordering (T010)', () => {
  test('follows the fixed PRD order with unclassified last', () => {
    const sorted = sortByPriority([
      item({ sourceKey: 'u', category: null }),
      item({ sourceKey: 'pw', category: 'pennwest' }),
      item({ sourceKey: 'if', category: 'interactive-foundation' }),
      item({ sourceKey: 'bp', category: 'business-personal' }),
      item({ sourceKey: 'tw', category: 'thriveworks-pr' }),
      item({ sourceKey: 'pt', category: 'patient' }),
    ]);
    assert.deepEqual(sorted.map((i) => i.sourceKey), ['pt', 'tw', 'bp', 'if', 'pw', 'u']);
  });

  test('priority beats urgency; within a category urgency, deadline, then receipt order', () => {
    const sorted = sortByPriority([
      item({ sourceKey: 'pr-urgent', category: 'thriveworks-pr', urgentExplicit: true, deadline: '2026-11-05' }),
      item({ sourceKey: 'pt-late', category: 'patient', receivedAt: '2026-11-03T00:00:00Z' }),
      item({ sourceKey: 'pt-deadline-later', category: 'patient', urgentExplicit: true, deadline: '2026-11-20' }),
      item({ sourceKey: 'pt-deadline-sooner', category: 'patient', urgentExplicit: true, deadline: '2026-11-06' }),
      item({ sourceKey: 'pt-early', category: 'patient', receivedAt: '2026-11-02T00:00:00Z' }),
    ]);
    assert.deepEqual(sorted.map((i) => i.sourceKey), [
      'pt-deadline-sooner',
      'pt-deadline-later',
      'pt-early',
      'pt-late',
      'pr-urgent',
    ]);
  });

  test('is deterministic for identical items', () => {
    const a = item({ sourceKey: 'b', category: 'patient' });
    const b = item({ sourceKey: 'a', category: 'patient' });
    assert.deepEqual(sortByPriority([a, b]).map((i) => i.sourceKey), ['a', 'b']);
    assert.deepEqual(sortByPriority([b, a]).map((i) => i.sourceKey), ['a', 'b']);
  });

  test('labels and ranks', () => {
    assert.equal(rankOf('patient'), 1);
    assert.equal(rankOf(null), 6);
    assert.equal(priorityLabel('thriveworks-pr'), 'P2 Jennifer / Thriveworks PR');
    assert.equal(priorityLabel(null), 'Unclassified');
  });
});
