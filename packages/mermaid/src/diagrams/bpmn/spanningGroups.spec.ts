import { describe, expect, it } from 'vitest';
import { titleShift } from './spanningGroups.js';

describe('titleShift', () => {
  const title = { left: 10, top: 0, right: 60, bottom: 14 };

  it('leaves a title that nothing covers where it is', () => {
    expect(titleShift(title, 100, () => true)).toBe(0);
  });

  it('slides a title along the top edge past a line through it', () => {
    // A vertical line at x = 40.
    const isFree = (box: typeof title) => !(box.left < 43 && box.right > 37);
    expect(titleShift(title, 100, isFree)).toBe(36);
  });

  it('slides back to the left when that is nearer', () => {
    // A vertical line at x = 55, near the title's right end.
    const isFree = (box: typeof title) => !(box.left < 58 && box.right > 52);
    expect(titleShift(title, 100, isFree, 40)).toBe(-8);
    expect(titleShift(title, 100, isFree)).toBe(48);
  });

  it('stays put when the edge has no free place', () => {
    expect(titleShift(title, 20, () => false)).toBe(0);
  });
});
