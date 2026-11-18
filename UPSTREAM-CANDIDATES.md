# Upstream candidates

Fixes to shared code (shapes, edges, swimlane layout) made on this branch that should be sent
upstream separately. One line each: commit, area, what was wrong.

- `35c095ef` swimlanes `direction/endpointClip.ts`: an edge given a diamond vertex that faces away from its route (others taken, bottom kept for a caption) turned at the vertex and ran back through the shape; it now leaves by a 12 px stub and turns outside.
