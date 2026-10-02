# Public Canvas

Public Canvas is the first part of a collaborative drawing website. Its homepage is itself a shared drawing space: a visitor can arrive and start drawing without creating an account, choosing a room, or setting up a profile. Drawings persist across refreshes and later visits. Real-time synchronisation between open browsers is planned next, but is not part of this version.

## What good means

For the public canvas, good means **easy to join, expressive enough to draw with, and shared without giving one participant destructive control over another participant's contribution**.

The first part is about reducing the distance between arriving and participating. Cheng and Hill's study of newcomer participation in Scratch describes several forms of legitimate peripheral participation rather than treating community membership as a single path. I take this as support for letting a newcomer begin with a small contribution before requiring a stronger identity or commitment. Here, opening the homepage is enough to begin drawing; anonymous identity is handled by the application in the background.

The shared canvas also needs to make other people's activity meaningful. Erickson and Kellogg describe socially translucent systems through visibility, awareness, and accountability: people can structure their behaviour when the activity of others is perceptible. A drawing canvas makes this unusually literal. Existing marks are the evidence that other people have been here, and new drawings can respond to, overlap, or work around them. I do not interpret social translucence as requiring unrestricted control. Participants can draw over earlier marks, but the eraser affects only their own work. This keeps visual interaction possible without turning erasing into a way to directly delete another person's contribution.

FlockMod is a practical precedent for low-friction collaborative drawing: it runs in a browser, does not require an account to draw, and organises collaboration around shared rooms. This project will also have private rooms, with richer drawing controls and persistent work. The additional interaction I am exploring is a public mode before that room model: the homepage itself is a common canvas, so encountering other people's work does not first require creating or joining a private space.

## Enforced and judged

Some parts of this definition are mechanically enforced. Draw and erase operations are persisted in SQLite and replayed in deterministic server order. Anonymous ownership is assigned by the server, and erase operations affect only the owner's drawing layer. Automated checks cover persisted operation data, ordering, ownership isolation, and stable history across refreshes.

Other qualities require judgement rather than a passing test. I judge whether the brush and eraser respond closely enough to the pointer to feel like drawing tools rather than demo controls, whether their size controls provide enough useful variation, and whether entering the canvas actually feels immediate. These are interaction qualities I test by drawing with the application, not claims I infer from unit tests.

## What I am not building yet

This version deliberately does not include accounts, profiles, chat, likes, pressure sensitivity, private rooms, or a full professional-editor toolset. Real-time synchronisation is the next multi-user step. The public canvas is also intended eventually to become temporary, with old work fading and expiring, but its lifetime and fading behaviour are not yet decided or implemented.

## References

- Thomas Erickson and Wendy A. Kellogg (2000), *Social Translucence: An Approach to Designing Systems that Support Social Processes*. ACM Transactions on Computer-Human Interaction. https://smg.media.mit.edu/library/erickson2000.pdf
- Ruijia Cheng and Benjamin Mako Hill (2022), *Many Destinations, Many Pathways: A Quantitative Analysis of Legitimate Peripheral Participation in Scratch*. Proceedings of the ACM on Human-Computer Interaction. https://arxiv.org/abs/2211.04046
- FlockMod, collaborative drawing platform and documentation. https://flockmod.com/
