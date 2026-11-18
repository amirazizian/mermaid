# Upstream candidates

Fixes to shared code (shapes, edges, swimlane layout) made on this branch that should be sent
upstream separately. One line each: commit, area, what was wrong.

- `35c095ef` swimlanes `direction/endpointClip.ts`: an edge given a diamond vertex that faces away from its route (others taken, bottom kept for a caption) turned at the vertex and ran back through the shape; it now leaves by a 12 px stub and turns outside.
- `379dba63` swimlanes `direction/participantLinks.ts`: a message flow to a pool or lane was drawn as a straight run that ignored nodes of its own pool across it, running through a task; it now goes round them.
- `22a8fb2a` swimlanes `direction/materializedGeometry.ts`: the crossing resolver's outer-channel reroutes could leave the pool of both ends (a sequence flow drawn outside its pool to avoid one crossing); candidates are now kept inside that pool.
- `0b475cb8` swimlanes TB (`direction/emptyLanesTb.ts`, `participantLinks.ts`, `materializedGeometry.ts`): in TB a black-box pool or empty lane had zero width and was drawn inside the previous pool's column; it now gets its own column, and message flows to it are orthogonal.
