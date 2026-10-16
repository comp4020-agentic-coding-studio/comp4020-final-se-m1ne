# Crit 10 Reflection

## 1. What was the breakthrough that moved the work forward?

The biggest breakthrough was finally getting the layer system to render correctly. At first, the automated tests passed, but drawings on lower layers could still appear above higher layers. Fixing one problem sometimes created another, especially with live strokes and shape previews.

I realised that the tests were checking whether the code called the right functions, but not necessarily what people actually saw on the canvas. I started using more specific visual checks and asked Claude to focus on the rendering process instead of repeatedly changing unrelated parts of the editor.

Once the layer system worked properly, I could continue adding tools like the paint bucket and airbrush. This made the editor feel much more complete without abandoning the original goal of collaborative drawing.

## 2. What did this work change about who I want to be as a software developer?

This week made me realise that I do not want to be a developer who only checks whether the code runs or the tests pass. I want to understand how people actually experience what I build.

Working with Claude also taught me to be more careful about giving instructions. A small change can unexpectedly affect something that already works, so I need to define clear boundaries and check the results myself.

I want to become a developer who uses AI as a useful tool, but still takes responsibility for the decisions, the quality of the software and the experience of the people using it.
