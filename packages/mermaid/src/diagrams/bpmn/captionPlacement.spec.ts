import { describe, it, expect } from 'vitest';
import type { Box, Point } from './captionPlacement.js';
import {
  avoidCaptionCrossings,
  captionBoxAt,
  captionCandidates,
  isBlocked,
  keepCaptionRoomBeside,
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

  it('moves a caption that covers another shape, such as a boundary event its host', () => {
    // A boundary event on the right side of its host: the name under it is on the host.
    const host: Box = { left: -200, top: -60, right: 0, bottom: 60 };
    const move = placeCaption(shape, caption, { linePoints: [], occupied: [host] });
    expect(move).toBeDefined();
    const box = { ...caption };
    box.left += move!.dx;
    box.right += move!.dx;
    box.top += move!.dy;
    box.bottom += move!.dy;
    expect(isBlocked(box, { linePoints: [], occupied: [host] })).toBe(false);
  });

  it('moves a caption that reaches over its bounds back inside them', () => {
    const lane: Box = { left: -200, top: -100, right: 200, bottom: 35 };
    const move = placeCaption(shape, caption, { linePoints: [], occupied: [], bounds: lane });
    expect(move?.place).toBe('above');
  });

  it('slides a caption along the side of its shape before going to a corner', () => {
    // A line leaves the shape downwards, and something holds the place above.
    const linePoints = vertical(0, 18, 200);
    const above: Box = { left: -100, top: -100, right: 100, bottom: -20 };
    const right: Box = { left: 20, top: -30, right: 200, bottom: 14 };
    const move = placeCaption(shape, caption, { linePoints, occupied: [above, right] });
    expect(move?.place).toBe('below');
    expect(Math.abs(move!.dx)).toBeGreaterThan(30);
    expect(move!.dy).toBe(0);
  });

  it('prefers a place that keeps some room to a line', () => {
    // A line 1 px beside where the caption would go above.
    const linePoints = [...vertical(0, 18, 200), ...vertical(31, -60, -20)];
    const move = placeCaption(shape, caption, { linePoints, occupied: [] });
    expect(move?.place).toBe('above');
    // Slid clear of the line by more than the 2 px that counts as touching it.
    expect(caption.right + move!.dx).toBeLessThan(31 - 2);
  });

  it('lists the places around a shape nearest first', () => {
    const candidates = captionCandidates(shape, caption);
    expect(candidates[0].place).toBe('below');
    expect(candidates[0].box).toEqual(caption);
    expect(candidates.findIndex((c) => c.place === 'above')).toBeLessThan(
      candidates.findIndex((c) => c.place === 'above-left')
    );
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

describe('keepCaptionRoomBeside', () => {
  it('asks events and gateways that flows pass through for room beside them', () => {
    const nodes = [
      { id: 's', shape: 'bpmn-start', label: 'Start' },
      { id: 'i', shape: 'bpmn-intermediate', label: 'Wait' },
      { id: 'g', shape: 'bpmn-gateway', label: 'Ok?' },
      { id: 'n', shape: 'bpmn-gateway', label: '' },
      { id: 't', shape: 'bpmn-activity', label: 'Do' },
      { id: 'e', shape: 'bpmn-end', label: 'End' },
    ] as { id: string; shape: string; label: string; metadata?: Record<string, unknown> }[];
    const edges = [
      { start: 's', end: 'i' },
      { start: 'i', end: 'g' },
      { start: 'g', end: 'n' },
      { start: 'n', end: 't' },
      { start: 't', end: 'e' },
    ];
    keepCaptionRoomBeside({ nodes, edges });
    expect(nodes.filter((node) => node.metadata?.captionBeside).map((node) => node.id)).toEqual([
      'i',
      'g',
    ]);
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
