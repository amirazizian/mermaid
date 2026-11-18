# Upstream candidates

Fixes to shared code (shapes, edges, swimlane layout) made on this branch that should be sent
upstream separately. One line each: commit, area, what was wrong.

- `35c095ef` swimlanes `direction/endpointClip.ts`: an edge given a diamond vertex that faces away from its route (others taken, bottom kept for a caption) turned at the vertex and ran back through the shape; it now leaves by a 12 px stub and turns outside.
- `379dba63` swimlanes `direction/participantLinks.ts`: a message flow to a pool or lane was drawn as a straight run that ignored nodes of its own pool across it, running through a task; it now goes round them.
- `22a8fb2a` swimlanes `direction/materializedGeometry.ts`: the crossing resolver's outer-channel reroutes could leave the pool of both ends (a sequence flow drawn outside its pool to avoid one crossing); candidates are now kept inside that pool.
- `0b475cb8` swimlanes TB (`direction/emptyLanesTb.ts`, `participantLinks.ts`, `materializedGeometry.ts`): in TB a black-box pool or empty lane had zero width and was drawn inside the previous pool's column; it now gets its own column, and message flows to it are orthogonal.
- `47ae8756` swimlanes `direction/labelAnchoring.ts`: flow labels were clamped flush onto lane borders and could sit on bends of their own line; labels are now placed by a search along the whole line, clear of borders, bends, nodes and other labels.
- (no commit; worked around in `36344745`) `createText` draws a wrapped HTML label in a box as wide as the wrapping width, not its longest line, so wrapped captions claim more room than they use.
- `c1b76c92`, `ca29e7f1`, `e6556322` swimlanes `direction/endpointClip.ts` + `direction/vertexPorts.ts`: a diamond's vertex was picked by the direction to the router's first bend (measured from the whole box, caption room included), so a flow starting beside the box took the vertex facing away and looped round its own shape; vertices are now chosen by costing short ways onto the route.
- `41ca7764` swimlanes `anchoredNodes.ts` / `phase4.coordinates.ts`: in TB a node pinned on its host's border sat on the middle of the right side, covering the host's label, with no room kept for its caption; it now sits on the bottom border towards the right, as in LR.
- `4cb8be8c` swimlanes `helpers.ts` (`writeBackToLayoutData`) / `anchoredNodes.ts`: in TB a lane or pool was sized from its nodes only, ignoring the room reserved for pinned artifacts, so data objects and notes were drawn outside their lane; nested parallel association stubs replaced by straight stubs or single L shapes.
