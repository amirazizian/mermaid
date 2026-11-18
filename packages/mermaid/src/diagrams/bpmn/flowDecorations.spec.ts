import { describe, expect, it } from 'vitest';
import type { Point, Rect } from './flowDecorations.js';
import { crossesBorderOf, decorateFlows, placeEnvelope } from './flowDecorations.js';

/** A line sampled every 2 px through the given corners. */
const line = (...corners: Point[]): Point[] => {
  const points: Point[] = [corners[0]];
  for (let i = 1; i < corners.length; i++) {
    const from = corners[i - 1];
    const to = corners[i];
    const steps = Math.round(Math.hypot(to.x - from.x, to.y - from.y) / 2);
    for (let k = 1; k <= steps; k++) {
      points.push({
        x: from.x + ((to.x - from.x) * k) / steps,
        y: from.y + ((to.y - from.y) * k) / steps,
      });
    }
  }
  return points;
};
const envelope = { width: 20, height: 14 };
const label = { width: 50, height: 20 };
const free = () => true;
const inside = (box: Rect, point: Point) =>
  point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;

describe('placeEnvelope', () => {
  it('puts the envelope in the middle of a straight line, with its label right beside it', () => {
    const place = placeEnvelope(line({ x: 0, y: 0 }, { x: 200, y: 0 }), 2, envelope, label, free);
    expect(place?.envelope).toEqual({ x: 100, y: 0 });
    // On the line, the envelope's half, a gap and the label's half away.
    expect(place?.label?.y).toBe(0);
    expect(Math.abs(Math.abs(place!.label!.x - 100) - (10 + 4 + 25))).toBeLessThanOrEqual(1);
  });

  it('keeps the envelope and its label on one straight stretch, clear of a bend', () => {
    const samples = line({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 200 });
    const place = placeEnvelope(samples, 2, envelope, label, free)!;
    expect(place.envelope.x).toBe(100);
    expect(place.label?.x).toBe(100);
    expect(place.envelope.y).toBeGreaterThan(7);
  });

  it('moves along the line off whatever is in the way', () => {
    const blocker: Rect = { left: 80, top: -20, right: 140, bottom: 20 };
    const place = placeEnvelope(
      line({ x: 0, y: 0 }, { x: 300, y: 0 }),
      2,
      envelope,
      label,
      (box) => !(box.left < blocker.right && blocker.left < box.right)
    )!;
    expect(place.envelope.x + 10 <= blocker.left || place.envelope.x - 10 >= blocker.right).toBe(
      true
    );
    expect(place.label).toBeDefined();
  });

  it('places the envelope alone, off its label, when the label does not fit beside it', () => {
    const samples = line({ x: 0, y: 0 }, { x: 70, y: 0 });
    const labelAt: Rect = { left: 10, top: -10, right: 60, bottom: 10 };
    const place = placeEnvelope(samples, 2, envelope, label, free, labelAt);
    expect(place?.label).toBeUndefined();
    expect(place).toBeUndefined();
    const longer = line({ x: 0, y: 0 }, { x: 120, y: 0 });
    const alone = placeEnvelope(longer, 2, envelope, { width: 200, height: 20 }, free, labelAt)!;
    expect(alone.label).toBeUndefined();
    expect(inside(labelAt, alone.envelope)).toBe(false);
  });
});

describe('crossesBorderOf', () => {
  const band: Rect = { left: 0, top: 0, right: 100, bottom: 100 };
  it('counts a box across or right against a band border, but not one well inside or out', () => {
    expect(crossesBorderOf(band, { left: 10, top: 90, right: 30, bottom: 110 })).toBe(true);
    expect(crossesBorderOf(band, { left: 10, top: 80, right: 30, bottom: 99 })).toBe(true);
    expect(crossesBorderOf(band, { left: 10, top: 10, right: 30, bottom: 30 })).toBe(false);
    expect(crossesBorderOf(band, { left: 10, top: 110, right: 30, bottom: 130 })).toBe(false);
  });
});

describe('decorateFlows', () => {
  it('does nothing without a drawing to measure', () => {
    expect(() => decorateFlows(null)).not.toThrow();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.innerHTML =
      '<g class="edgePaths"><path class="bpmn-flow-message-initiating" data-id="f" d="M0,0L10,0"/></g>';
    expect(() => decorateFlows(svg)).not.toThrow();
  });
});
