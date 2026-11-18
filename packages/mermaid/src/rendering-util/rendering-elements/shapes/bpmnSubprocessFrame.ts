import type { D3Selection } from '../../../types.js';
import type { Node } from '../../types.js';
import { labelHelper, getNodeClasses, updateNodeBounds } from './util.js';
import { styles2String } from './handDrawnShapeStyles.js';
import { createRoundedRectPathD } from './roundedRectPath.js';
import { faceProjectIntersect, glyphSvg, type BpmnNode } from './bpmnShapeCore.js';

const RADIUS = 10;
const DOUBLE_GAP = 3;
const MARKER_SIZE = 14;
/** Room around the content, and above it for the title. */
export const FRAME_PADDING = 16;
const TITLE_GAP = 6;

/**
 * An expanded sub-process: a rounded frame with its title in the top-left corner, around content
 * laid out on its own beforehand. `node.metadata.content` gives the size of that content, and the
 * frame records in its `data-content-x` and `data-content-y` attributes where the content's
 * top-left corner goes, relative to the node's centre. `node.metadata.frameBorder` is `solid`, `dotted` (an event sub-process) or
 * `double` (a transaction), and `node.markers` are drawn centred on the bottom edge.
 */
export async function bpmnSubprocessFrame<T extends SVGGraphicsElement>(
  parent: D3Selection<T>,
  node: Node
): Promise<D3Selection<SVGGElement>> {
  const frameNode = node as BpmnNode;
  const { labelStyles, nodeStyles } = styles2String(node);
  node.labelStyle = labelStyles;
  const metadata = (node.metadata ?? {}) as {
    content?: { width: number; height: number };
    frameBorder?: 'solid' | 'dotted' | 'double';
  };
  const border = metadata.frameBorder ?? 'solid';

  const { shapeSvg, bbox, label } = await labelHelper(
    parent,
    node,
    getNodeClasses(node, `bpmn-subprocess-frame frame-${border}`)
  );

  const content = metadata.content ?? { width: 0, height: 0 };
  const markers = frameNode.markers ?? [];
  const inset = border === 'double' ? DOUBLE_GAP : 0;
  const titleBand = bbox.height > 0 ? bbox.height + TITLE_GAP : 0;
  const markerBand = markers.length ? MARKER_SIZE + 4 : 0;
  const width = Math.max(
    content.width + 2 * (FRAME_PADDING + inset),
    bbox.width + 2 * (RADIUS + inset) + 4,
    100
  );
  const height = Math.max(
    content.height + titleBand + markerBand + 2 * (FRAME_PADDING + inset),
    80
  );
  const left = -width / 2;
  const top = -height / 2;

  const body = shapeSvg.insert('g', ':first-child').attr('class', 'bpmn-frame');
  body
    .append('path')
    .attr('class', 'bpmn-frame-outline')
    .attr('d', createRoundedRectPathD(left, top, width, height, RADIUS))
    .attr('style', nodeStyles);
  if (border === 'double') {
    body
      .append('path')
      .attr('class', 'bpmn-frame-outline-inner')
      .attr(
        'd',
        createRoundedRectPathD(
          left + DOUBLE_GAP,
          top + DOUBLE_GAP,
          width - 2 * DOUBLE_GAP,
          height - 2 * DOUBLE_GAP,
          RADIUS - DOUBLE_GAP
        )
      );
  }

  if (markers.length) {
    const row = body.append('g').attr('class', 'bpmn-activity-markers');
    const rowWidth = markers.length * MARKER_SIZE;
    for (const [index, marker] of markers.entries()) {
      const cell = row.append('g');
      cell.html(`<g>${await glyphSvg(marker, MARKER_SIZE)}</g>`);
      cell.attr('transform', `translate(${-rowWidth / 2 + index * MARKER_SIZE}, 0)`);
    }
    row.attr('transform', `translate(0, ${top + height - MARKER_SIZE - 4 - inset})`);
  }

  // The title sits inside the top-left corner, clear of the rounding. It is part of the frame,
  // not a caption, so it is not named a label, which passes that place captions would move.
  label.attr('class', 'bpmn-frame-title');
  label.attr('transform', `translate(${left + RADIUS + inset}, ${top + inset + 4})`);

  // The content is centred across the frame, under the title.
  const usableTop = top + inset + FRAME_PADDING / 2 + titleBand;
  const usableBottom = top + height - inset - FRAME_PADDING / 2 - markerBand;
  // Where the content's top-left corner goes, for whoever draws the content into the frame.
  shapeSvg
    .attr('data-content-x', -content.width / 2)
    .attr('data-content-y', (usableTop + usableBottom) / 2 - content.height / 2);

  updateNodeBounds(node, body);
  node.intersect = function (point) {
    return faceProjectIntersect(node, width, height, point);
  };
  return shapeSvg;
}
