import { describe, it, expect } from 'vitest';
import type { Box, Point } from './captionPlacement.js';
import {
  avoidCaptionCrossings,
  captionBoxAt,
  isCrossed,
  placeCaption,
} from './captionPlacement.js';

// A 36 px event at the origin with a 60 x 16 caption under it, 6 px down.
const shape: Box = { left: -18, top: -18, right: 18, bottom: 18 };
const caption = captionBoxAt(shape, { left: 0, top: 0, right: 60, bottom: 16 }, 'below');

/** A vertical line at `x` from `top` to `bottom`, sampled every 2 px. */
const vertical = (x: number, top: number, bottom: number): Point[] =>
  Array.from({ length: Math.floor((bottom - top) / 2) + 1 }, (_, i) => ({ x, y: top + i * 2 }));
const horizontal = (y: number, left: number, right: number): Point[] =>
  Array.from({ length: Math.floor((right - left) / 2) + 1 }, (_, i) => ({ x: left + i * 2, y }));

const centreOf = (box: Box) => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });

describe('placeCaption', () => {
  it('starts a caption centred under its shape', () => {
    expect(centreOf(caption)).toEqual({ x: 0, y: 32 });
  });

  it('leaves a caption no line touches where it is', () => {
    expect(placeCaption(shape, caption, { linePoints: horizontal(0, 18, 200), occupied: [] })).toBe(
      undefined
    );
  });

  it('moves a caption above its shape when a line leaves the shape downwards through it', () => {
    const move = placeCaption(shape, caption, { linePoints: vertical(0, 18, 200), occupied: [] });
    expect(move?.place).toBe('above');
    expect(centreOf(captionBoxAt(shape, caption, 'above')).y).toBe(-32);
  });

  it('goes beside the shape when lines leave both from below and above', () => {
    const linePoints = [...vertical(0, 18, 200), ...vertical(0, -200, -18)];
    expect(placeCaption(shape, caption, { linePoints, occupied: [] })?.place).toBe('right');
  });

  it('skips a place another shape or text already holds', () => {
    const linePoints = vertical(0, 18, 200);
    const host: Box = { left: -60, top: -100, right: 60, bottom: -20 };
    expect(placeCaption(shape, caption, { linePoints, occupied: [host] })?.place).toBe('right');
  });

  it('keeps a caption inside its lane', () => {
    const linePoints = vertical(0, 18, 200);
    const lane: Box = { left: -200, top: -20, right: 200, bottom: 300 };
    expect(placeCaption(shape, caption, { linePoints, occupied: [], bounds: lane })?.place).toBe(
      'right'
    );
  });

  it('stays put when every place is taken', () => {
    const linePoints = [
      ...vertical(0, -300, 300),
      ...horizontal(0, -300, 300),
      ...vertical(60, -300, 300),
      ...vertical(-60, -300, 300),
    ];
    expect(placeCaption(shape, caption, { linePoints, occupied: [] })).toBe(undefined);
  });

  it('counts a line grazing the caption as touching it', () => {
    expect(
      isCrossed(caption, { linePoints: vertical(caption.right + 1, 0, 100), occupied: [] })
    ).toBe(true);
    expect(
      isCrossed(caption, { linePoints: vertical(caption.right + 5, 0, 100), occupied: [] })
    ).toBe(false);
  });
});

describe('avoidCaptionCrossings', () => {
  it('does nothing without a drawing to measure', () => {
    expect(() => avoidCaptionCrossings(null)).not.toThrow();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.innerHTML = '<g class="edgePaths"><path d="M0,0L10,0"/></g>';
    expect(() => avoidCaptionCrossings(svg)).not.toThrow();
  });
});
