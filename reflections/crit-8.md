# Crit 8 Reflection

## What was the breakthrough that moved the work forward?

The breakthrough was realising that adding more drawing features would not make the project feel like a drawing application if the underlying canvas still behaved like a webpage element. I initially focused on getting the public canvas working: persistent operations, owner-only erasing, fading, private rooms and undo/redo. These features worked, but the result still felt closer to a functional canvas demo than drawing software.

That changed when I stopped adding individual tools and treated the artwork document and the interface displaying it as separate things. The canvas is now a fixed 1920×1080 document inside a workspace that can zoom, fit and pan without changing the artwork itself. This also gave me a clearer foundation for the next systems, particularly brushes, layers and real-time collaboration.

The same lesson appeared earlier with the eraser. Trying to keep splitting vector strokes was technically possible, but changing to persistent raster operations produced a model that better matched the interaction I actually wanted. In both cases, progress came from changing the representation instead of continuing to patch behaviour onto the wrong foundation.

## What did this work change about who I am as a builder?

This work made me less willing to treat a passing test or a completed feature as evidence that an interaction is good. Automated checks are useful for guarantees such as persistence, ownership, ordering and history, but they cannot tell me whether an eraser feels delayed or whether a workspace feels like drawing software.

I also became more comfortable stopping implementation to reconsider architecture. Earlier I tended to think of progress as completing the next feature. In this project, some of the most useful progress came from deciding not to implement the next feature yet. Before starting the new brush system, I first investigated how opacity, replay, fading, ownership and future real-time synchronisation would interact with it.

I now see the coding agent less as something that should decide what the finished interaction ought to be, and more as a tool for exploring implementations, checking constraints and exposing architectural consequences. I still need to use the application myself, reject technically valid results when they do not feel right, and decide when the underlying model needs to change.