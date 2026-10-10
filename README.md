# Shared Canvas

Shared Canvas is a real-time collaborative drawing website where people can create something together without accounts. Visitors first see the live Public Canvas, then enter with a nickname and cursor colour. They can draw on the public canvas or create a private room and invite friends using a short code.

## What good means

For this project, good means **easy to join, meaningful to use together, and respectful of each person's contributions**. The goal is not to reproduce a professional drawing application, but to make shared drawing feel welcoming, immediate and safe enough for strangers to participate.

Cheng and Hill's research on participation in Scratch suggests that online creative communities benefit from different ways to become involved. Shared Canvas follows this idea by keeping entry simple. Visitors can watch the public artwork before joining, start drawing without creating an account, or choose a private room for a smaller group.

Erickson and Kellogg's concept of social translucence connects visibility, awareness and accountability. In Shared Canvas, live strokes, coloured cursors and optional nicknames help people notice one another. Seeing a line appear while somebody draws makes collaboration feel different from simply viewing a finished picture. Participants can respond to each other's work as it happens.

However, visibility alone does not make a shared space comfortable. Each participant can erase and undo only their own contributions. This limits accidental or deliberate destruction without requiring moderators or permanent accounts.

FlockMod demonstrates the appeal of accessible browser-based collaborative drawing. Shared Canvas takes a related approach but distinguishes two kinds of shared space. Public artwork gradually fades and disappears after 12.5 hours, giving the canvas a changing, temporary character. Private-room artwork does not fade, although a room expires after 24 hours of continuous emptiness. These different lifetimes encourage spontaneous public participation and more intentional drawing with friends.

## Enforced and judged

Automated checks cover persistent operations, ownership restrictions, deterministic ordering, undo/redo, fading, room isolation, lifecycle rules and real-time event handling. Server-sent events deliver changes to other open sessions without requiring a refresh. The application also keeps drawing operations separate from temporary cursor and in-progress stroke previews.

Other qualities require human judgement. I test with separate browser sessions to see whether strokes appear promptly, whether remote cursors are understandable, whether erasing behaves predictably, and whether newcomers can understand the difference between public and private spaces. I also check that the interface remains usable at different browser sizes.

## Current boundaries

Shared Canvas provides basic freehand drawing, erasing, colour selection, zoom and navigation, guest profiles, live cursors and shared rooms. It does not aim to provide a complete professional painting toolkit. Advanced brushes, layers, selection tools, pressure sensitivity, chat and permanent accounts are outside the current version.

The remaining work focuses on reliability and clarity, particularly consistent synchronization and cursor positioning when participants use different window sizes.

## References

- Thomas Erickson and Wendy A. Kellogg (2000), *Social Translucence: An Approach to Designing Systems that Support Social Processes*. ACM Transactions on Computer-Human Interaction. https://smg.media.mit.edu/library/erickson2000.pdf
- Ruijia Cheng and Benjamin Mako Hill (2022), *Many Destinations, Many Pathways: A Quantitative Analysis of Legitimate Peripheral Participation in Scratch*. Proceedings of the ACM on Human-Computer Interaction. https://arxiv.org/abs/2211.04046
- FlockMod, collaborative drawing platform. https://flockmod.com/
