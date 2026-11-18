import { getConfig } from '../../diagram-api/diagramAPI.js';
import type { DiagramStyleClassDef } from '../../diagram-api/types.js';
import { log } from '../../logger.js';
import { getDiagramElement } from '../../rendering-util/insertElementsForSize.js';
import { render } from '../../rendering-util/render.js';
import { setupViewPortForSVG } from '../../rendering-util/setupViewPortForSVG.js';
import type { LayoutData } from '../../rendering-util/types.js';
import utils from '../../utils.js';
import { avoidCaptionCrossings } from './captionPlacement.js';
import { decorateFlows } from './flowDecorations.js';

export const getClasses = function (
  _text: string,
  diagramObj: any
): Map<string, DiagramStyleClassDef> {
  return diagramObj.db.getClasses();
};

const DEFAULT_LANE = '__swimlane_default__';

/** Fills in what the renderer adds to a layout before it is drawn. */
const prepare = (data: LayoutData, type: string, direction: string, id: string, conf: any) => {
  data.type = type;
  data.direction = direction;
  data.nodeSpacing = conf?.nodeSpacing ?? 35;
  data.rankSpacing = conf?.rankSpacing ?? 40;
  data.diagramId = id;
  return data;
};

interface Content {
  group: SVGGElement;
  box: Box;
  /** The id the frame of this sub-process is drawn with, in the layout around it. */
  frameDomId: string;
}

/**
 * Lays out and draws the inside of each expanded sub-process on its own, innermost first, so
 * that each can be drawn as one node of known size in the layout around it. The content is
 * drawn without the lane a layout puts loose elements in.
 */
async function drawSubprocessContents(diag: any, svg: any, id: string, conf: any) {
  const contents = new Map<string, Content>();
  const sizes = new Map<string, { width: number; height: number }>();
  for (const sub of diag.db.expandedSubprocesses() as string[]) {
    const contentId = `${id}-${sub}`;
    const data = prepare(
      diag.db.getData({ scope: sub, frames: sizes }) as LayoutData,
      diag.type,
      diag.db.getDirection(),
      contentId,
      conf
    );
    const group = svg.append('g').attr('class', 'bpmn-subprocess-content');
    // A layout draws into the first group of what it is given.
    group.append('g');
    await render(data, group);
    group.selectAll(`[data-id="${DEFAULT_LANE}"], [id="${contentId}-${DEFAULT_LANE}"]`).remove();
    const element = group.node() as SVGGElement;
    // Measured from what is drawn, so the lane's empty band is left out.
    const parts = [
      ...element.querySelectorAll<SVGGraphicsElement>(
        'g.node, path.flowchart-link, g.edgeLabel, g.cluster'
      ),
    ];
    const own = element.getBBox();
    const box = unionBox(parts) ?? { x: own.x, y: own.y, width: own.width, height: own.height };
    sizes.set(sub, { width: box.width, height: box.height });
    const owner = diag.db.scopeOf(sub) as string | undefined;
    contents.set(sub, {
      group: element,
      box,
      frameDomId: `${owner ? `${id}-${owner}` : id}-${sub}`,
    });
  }
  return contents;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The box around the drawn parts, in the coordinates of the content group that holds them. Where
 * the DOM cannot say how a part is placed (as in a test DOM), its own box is taken as it is.
 */
function unionBox(parts: SVGGraphicsElement[]): Box | undefined {
  let box: { left: number; top: number; right: number; bottom: number } | undefined;
  for (const part of parts) {
    const own = part.getBBox();
    if (own.width === 0 && own.height === 0) {
      continue;
    }
    const content = part.closest<SVGGElement>('g.bpmn-subprocess-content');
    const matrix = typeof part.getCTM === 'function' ? part.getCTM() : null;
    const base = content && typeof content.getCTM === 'function' ? content.getCTM() : null;
    const toGroup = matrix && base ? base.inverse().multiply(matrix) : undefined;
    const corners = [
      [own.x, own.y],
      [own.x + own.width, own.y],
      [own.x, own.y + own.height],
      [own.x + own.width, own.y + own.height],
    ].map(([x, y]) => (toGroup ? new DOMPoint(x, y).matrixTransform(toGroup) : { x, y }));
    for (const corner of corners) {
      box = box
        ? {
            left: Math.min(box.left, corner.x),
            top: Math.min(box.top, corner.y),
            right: Math.max(box.right, corner.x),
            bottom: Math.max(box.bottom, corner.y),
          }
        : { left: corner.x, top: corner.y, right: corner.x, bottom: corner.y };
    }
  }
  return box
    ? { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }
    : undefined;
}

/** Moves each sub-process's content into its frame, where the frame left room for it. */
function placeSubprocessContents(svg: any, contents: Map<string, Content>) {
  const root = svg.node() as SVGSVGElement;
  for (const { group, box, frameDomId } of contents.values()) {
    const frame = root.querySelector<SVGGElement>(`[id="${frameDomId}"]`);
    if (!frame) {
      continue;
    }
    const x = Number(frame.getAttribute('data-content-x'));
    const y = Number(frame.getAttribute('data-content-y'));
    const at =
      frame.hasAttribute('data-content-x') && Number.isFinite(x) && Number.isFinite(y)
        ? { x, y }
        : { x: -box.width / 2, y: -box.height / 2 };
    frame.appendChild(group);
    group.setAttribute('transform', `translate(${at.x - box.x}, ${at.y - box.y})`);
  }
}

export const draw = async function (_text: string, id: string, _version: string, diag: any) {
  log.debug('Drawing bpmn diagram', id);
  const { securityLevel, bpmn: conf } = getConfig();

  diag.db.setDiagramId(id);
  const svg = getDiagramElement(id, securityLevel);

  const contents = await drawSubprocessContents(diag, svg, id, conf);
  const sizes = new Map(
    [...contents].map(([sub, { box }]) => [sub, { width: box.width, height: box.height }])
  );

  const data4Layout = prepare(
    diag.db.getData({ frames: sizes }) as LayoutData,
    diag.type,
    diag.db.getDirection(),
    id,
    conf
  );
  await render(data4Layout, svg);
  placeSubprocessContents(svg, contents);
  avoidCaptionCrossings(svg.node());
  decorateFlows(svg.node());

  const padding = conf?.diagramPadding ?? 12;
  const drawnTop = (svg.node() as SVGGraphicsElement | null)?.getBBox().y ?? 0;
  utils.insertTitle(
    svg,
    'bpmnTitleText',
    (conf?.titleTopMargin ?? 25) - drawnTop,
    diag.db.getDiagramTitle()
  );
  setupViewPortForSVG(svg, padding, 'bpmn', conf?.useMaxWidth ?? true);
};

export default {
  getClasses,
  draw,
};
