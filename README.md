# Shared Canvas

Shared Canvas is a real-time collaborative drawing website where people can create something together without accounts. Visitors can explore the Public Canvas, join with a nickname and cursor colour, or create a private room and invite friends using a short code. The project supports both pixel drawing and freehand drawing, with different tools and experiences for different spaces.

## What good means

For this project, good means **easy to join, meaningful to use together, and respectful of each person's contributions**. The goal is not to reproduce a professional drawing application, but to make shared drawing feel welcoming, immediate and safe enough for strangers to participate.

Cheng and Hill's research on participation in Scratch suggests that online creative communities benefit from different ways to become involved. Shared Canvas follows this idea by keeping entry simple. Visitors can watch the public artwork before joining, start drawing without creating an account, or choose a private room for a smaller group.

Erickson and Kellogg's concept of social translucence connects visibility, awareness and accountability. In Shared Canvas, live strokes, coloured cursors and optional nicknames help people notice one another. Seeing a line appear while somebody draws makes collaboration feel different from simply viewing a finished picture. Participants can respond to each other's work as it happens.

However, visibility alone does not make a shared space comfortable. Each participant can erase and undo only their own contributions. This limits accidental or deliberate destruction without requiring moderators or permanent accounts.

FlockMod demonstrates the appeal of accessible browser-based collaborative drawing. Shared Canvas takes a related approach but distinguishes two kinds of shared space. Public artwork gradually fades and disappears after 12.5 hours, giving the canvas a changing, temporary character. Private-room artwork does not fade, although a room expires after 24 hours of continuous emptiness. These different lifetimes encourage spontaneous public participation and more intentional drawing with friends.

## Enforced and judged

Automated checks cover persistent operations, ownership restrictions, deterministic ordering, undo/redo, fading, room isolation, lifecycle rules and real-time event handling. They also cover drawing behaviour such as layer ordering, shape rendering and fill operations. Server-sent events deliver changes to other open sessions without requiring a refresh. The application keeps persistent drawing operations separate from temporary cursor and in-progress stroke previews.

Other qualities require human judgement. I test with separate browser sessions to see whether strokes appear promptly, whether remote cursors are understandable, whether erasing behaves predictably, and whether newcomers can understand the difference between public and private spaces. I also check drawing tools, layer behaviour and interface usability at different browser sizes.

## Current boundaries

Shared Canvas supports pixel drawing and freehand drawing, with tools including pencils, airbrushes, erasers, paint buckets, shape tools, colour selection and zoom. The freehand editor also supports multiple layers with independent visibility and selection. Guest profiles, live cursors, undo/redo and shared rooms support collaboration without permanent accounts.

The project does not aim to replace a full professional painting application. Advanced selection and transformation tools, pressure sensitivity, chat and permanent accounts remain outside the current version.

## References

- Thomas Erickson and Wendy A. Kellogg (2000), *Social Translucence: An Approach to Designing Systems that Support Social Processes*. ACM Transactions on Computer-Human Interaction. https://smg.media.mit.edu/library/erickson2000.pdf
- Ruijia Cheng and Benjamin Mako Hill (2022), *Many Destinations, Many Pathways: A Quantitative Analysis of Legitimate Peripheral Participation in Scratch*. Proceedings of the ACM on Human-Computer Interaction. https://arxiv.org/abs/2211.04046
- FlockMod, collaborative drawing platform. https://flockmod.com/
