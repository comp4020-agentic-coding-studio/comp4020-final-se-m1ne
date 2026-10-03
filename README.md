# Public Canvas

Public Canvas is a collaborative drawing website built around two ways of sharing a canvas. The homepage is a public drawing space that anyone can enter and draw on immediately without an account. Visitors can also create or join a private room using a short room code. Both modes use persistent drawing operations, while the public canvas gradually fades old contributions and private rooms preserve their artwork while the room remains active.

## What good means

For this project, good means **easy to enter, responsive enough to feel like a drawing application, and collaborative without giving one anonymous participant destructive control over another participant's work**.

Low-friction participation shaped the public canvas. Cheng and Hill describe multiple pathways through which newcomers can participate in Scratch rather than a single route into community membership. Public Canvas applies that idea by making participation possible before identity or commitment: opening the homepage is enough to draw. Private rooms add a more intentional shared space without introducing accounts or profiles.

The second concern is how people encounter each other through the artwork. Erickson and Kellogg describe socially translucent systems in terms of visibility, awareness, and accountability. Here, previous marks make other participants visible through what they have contributed. People can draw beside, across, or in response to existing work, but the application distinguishes anonymous owners and only allows the eraser to remove the current participant's own pixels. Collaboration therefore changes the shared visual space without making deletion of somebody else's contribution a basic drawing action.

FlockMod provides a practical precedent for browser-based collaborative drawing with low barriers to participation and shared rooms. Public Canvas combines that general model with a common homepage canvas and temporary public history. Public drawing operations continuously fade according to their original creation time, while private-room artwork does not fade.

Drawing quality is also part of the definition of good. The application now uses a fixed 1920×1080 artwork document inside a separate workspace, with zoom, Fit, panning, size-aware tool cursors, colour controls, an eyedropper, and spatial erasing. The document is independent of browser size, so resizing or reopening a room does not redefine the artwork coordinate system. Undo and redo operate on each anonymous participant's own operation history.

## Enforced and judged

Persistence, deterministic operation order, anonymous ownership, owner-only erasing, undo/redo history, public fading, private-room isolation and lifecycle behaviour are covered by automated checks. The drawing document and coordinate calculations are also tested independently of viewport size.

Other qualities remain matters of judgement. I manually test whether drawing follows the pointer closely, whether zoom and panning still feel accurate, whether the interface reads as a drawing workspace rather than a canvas demo, and whether the boundary between shared interaction and destructive control feels understandable.

## Current boundary

Real-time synchronisation between simultaneously open browsers is not implemented yet. The current version also deliberately excludes accounts, profiles, chat, pressure sensitivity, layers, selection tools, shapes and a larger professional brush library. The next drawing-system work is a brush engine, followed by user layers; real-time synchronisation follows once that document model is stable.

## References

- Thomas Erickson and Wendy A. Kellogg (2000), *Social Translucence: An Approach to Designing Systems that Support Social Processes*. ACM Transactions on Computer-Human Interaction. https://smg.media.mit.edu/library/erickson2000.pdf
- Ruijia Cheng and Benjamin Mako Hill (2022), *Many Destinations, Many Pathways: A Quantitative Analysis of Legitimate Peripheral Participation in Scratch*. Proceedings of the ACM on Human-Computer Interaction. https://arxiv.org/abs/2211.04046
- FlockMod, collaborative drawing platform and documentation. https://flockmod.com/
