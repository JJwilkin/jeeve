---
date: 2026-10-10
tags: [research, system-1, latency, decision-models]
status: active
---
# Jev measured: latency, questions, options, bias

We measured TypeSafe Jev (`jev-1.13.0`) with our own access, rather than trusting the vendor numbers in [[decision-models]]. These measurements set the `decide()` bounds in [[system-1]].

**Setup:** about 300 calls to `POST https://api.typesafe.ai/v1/systemone` on 2026-10-10, sent from a Mac on a home or office network. States were synthetic Minecraft JSON: the bot's own status, an entity list using named distances, and an event window. Costs ~$0.04 in total. Samples are small (n = 6–12 per cell), so treat these as orders of magnitude.

## Results
| Question | Result |
|---|---|
| Network floor (`GET /v1/models`) | ~110 ms |
| Latency vs. state size (1 Choice, 3 options) | p50 **159 / 165 / 200 / 294 ms** at 0.7k / 2k / 7.6k / 22k input tokens; p95 ≤ 310 ms |
| Latency vs. number of questions (~1.5k-token state) | **Flat:** p50 162–173 ms from 1 to 32 questions |
| Latency vs. number of options | p50 143 ms at 3 options, 184 ms at 255 |
| Accuracy on an obvious pick (a hissing creeper among benign entities) | 72/72 correct at 8, 32, 128 and 255 options, with the right answer first, middle or last; p = 1.00 |
| **Position bias on an ambiguous pick** (a closing zombie vs. a skeleton drawing its bow) | Reversing the option order: with no distractors, p(zombie) goes 0.86 → 0.78. With 6–30 distractors, **0.80 → 0.14**, and the answer **flips**. |
| Raw coordinates vs. named distances (near zombie at 2.5 blocks vs. far one at 18–30) | Both p = 1.00. The case was too easy to separate them. |
| Run-to-run variance (the same request ×6) | Probabilities within ±0.03 |
| Concurrency | 4 and 16 calls in parallel: no 429s; p50 ~170–190 ms; one slow call at 1.2 s |

## Vendor documentation worth knowing
From [Models](https://docs.typesafe.ai/models.md), [API](https://docs.typesafe.ai/api.md) and [Jev 1.13 jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md):
- **Question types:** Choice (≤255 options), Score (2–10 levels) and Noul (a probability of yes). Questions in one call are evaluated "in parallel and in isolation" against one shared state. `instructions` and `criteria` can carry structured JSON, so a question can bring its own data.
- **Limits:** a 64k-token context, of which 32k is for the state plus the longest question. **80 req/s and 100k tokens/s per account**, "adjusting dynamically" and liable to change without notice. Only input tokens are charged ($0.042 per million).
- **Known weak spots:** reading questions literally; numbers, counting and arithmetic; comparing dates; multi-hop indirection; **large state full of irrelevant detail** ("context rot"); **option order**, with a lean toward the first option; generating text.
- **Versioning:** aliases (`jev-latest`) move between releases, so pin the versioned ID when thresholds have been tuned against it.

## Takeaways
- **Speed isn't the constraint.** Calls take ~160–300 ms, mostly network, so about 5 decisions/s per bot.
- **Questions are nearly free.** Ask per-channel questions, scores and the escalate check in one call. The same fact makes order-debiasing free: ask the same Choice forward and reversed in one call and average.
- **Options and state size are limited by accuracy, not latency.** Filter in the encoder, and keep each Choice's list short where the decision is a close call.
- **Do arithmetic in code.** Pass closing speed, distance buckets and directions, not raw vectors. That's the vendor's advice; our easy test couldn't tell the two apart.
- **Spell facts out, and match the guidance's words to the state's (measured 2026-10-11).** We replayed two recorded e2e states, 6 calls each with shuffled options: Jeeve far from the place it was told to stay by, choosing between "Stand still" and "Walk back to the goal's place (far, ahead)". P(walk back) went:
  - 0.25 / 0.08 with the state as recorded (`place: "far, ahead"`, and guidance saying "within ~3 blocks");
  - 0.85 / 0.69 with the state as a sentence ("you are far from the goal's place; it is ahead");
  - 0.83 / 0.68 with the guidance in the state's words ("very close", "close, medium or far") instead of block counts;
  - 0.98 / 0.97 with both.

  Adding the distance to the "Stand still" option instead (0.47 / 0.20) helped less. Jev doesn't join a terse field to numeric guidance.
- **Say the fact the decision turns on, not a scale (measured 2026-10-11).** With "you are close to the goal's place", Jev stood still 7.5 blocks short (P(walk on) 0.12–0.29), even though the guidance said "if you are close, medium or far, navigate back". "close" vs "very close" is too fine a line, and "close to" reads as "by it". "You are not at the goal's place yet; it is close, ahead" got 0.93, and 0.98–0.99 with guidance in the same words. Details in [[behaviors-and-guards]] → "Going back to a place".
- **Still unmeasured:**
  - calibration of `confidence` against System 2 labels,
  - p99 under multi-bot load from where the bots will run,
  - whether a stable prefix (guidance and examples) is cached.
