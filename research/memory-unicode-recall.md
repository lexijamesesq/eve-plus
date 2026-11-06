---
issue: none
status: implemented
last_updated: 2026-11-06
---

# Memory search: names in any script

`@eve-plus/memory` 0.6.2.

## Problem

`recall`, `relate` and turn-start recall build their full-text query by keeping only `[a-z0-9]` runs of the
lowercased text. "Zoë" became `zo`, "José" became `jos`, and "李明" became nothing, so a record stored under one of those
names was found only by a plain-ASCII spelling, if at all. Handles (0.6.0) keep such names in their own script, so an
agent could reach a record by handle but not by searching the name it knows.

## Choice: the index's own tokenizer, with an NFKC query

The search index is SQLite FTS5 with its default tokenizer, `unicode61` with `remove_diacritics 1`
([SQLite FTS5: the unicode61 tokenizer](https://www.sqlite.org/fts5.html#unicode61_tokenizer)). That tokenizer already treats letters and digits in every
script as token characters, folds case, and removes diacritics from Latin letters, on stored text and on each quoted
query term alike. The stored side was right; only the query discarded characters.

So the query now takes words as runs of letters, marks and digits (`\p{L}\p{M}\p{N}`) from the NFKC-normalised,
lowercased text, the same normalisation as `handleOf`. Each word is quoted and the words are OR-joined, as before, and
the tokenizer folds them the way it folds the index. Results:

- "Zoë", "zoe" and an NFD "Zoë" each find "Zoë Park".
- "José", "jose", "García" and "garcia" each find "José García".
- "李明" finds "李明". CJK text with no spaces is one token, so a query matches a whole run of characters, not part of
  one.
- Full-width "Ｚｏë" finds "Zoë Park": NFKC folds the query.

The rule that drops one- and two-character words as noise now applies to ASCII words only, so a two-character name
such as "李明" isn't dropped beside longer words. For ASCII input the tokens are the same as before, so ASCII search is
unchanged.

No new tokenizer is configured and nothing is hand-rolled; `unicode61` is the default the index was created with.

## No rebuild

Stored text and the index are unchanged: the index has always tokenized names in every script; only queries
couldn't reach them. So existing stores need no migration or reindex, and `eve-memory-stats`' index parity, which
compares the index to the current values exactly, is unaffected.

## Residual

Stored text isn't NFKC-normalised before indexing. A value saved in a compatibility form (full-width letters, a
ligature such as "ﬁ") is matched only by a query in that same form. Folding it would change the index's contents, and
existing stores would need a rebuild. Nothing observed asks for that, so nothing is built.
