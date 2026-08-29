---
"glua-core": patch
"glua-gmod": patch
---

Local module/OOP tables (`local Handler = {}` with `function Handler:Method()` or `Handler.field = ...`) now get completion, hover and argument-type checking for methods and fields added after the initial `{}` — previously only genuine globals tracked this. `self` inside such a method also sees sibling methods defined later in the same file.

Added snippet completions with proper tab stops for `function`, `function Table:Method()`, `if`/`if-else`, numeric and generic `for`, `while`, `repeat`, and a `class (module table)` boilerplate for the GLua module pattern — similar to how `rfce`-style snippets pre-place the cursor on the parts you're expected to edit.
