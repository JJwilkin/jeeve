---
date: 2026-10-10
tags: [research, system-1]
status: active
---
# Decision models

A class of models built for fast structured decisions, not open-ended text. They're candidates for fast thinking in [[overview]].

## The format
You send a state plus typed questions. Each answer comes back with **calibrated probabilities**, e.g. "pick one of these options" with a probability for each option. Several questions can go in one call.

This fits fast thinking well. One call per decision could ask:
- the next action: a choice from a fixed list,
- the threat level: a score,
- whether to escalate: yes or no.

Low confidence makes a natural signal to hand back to slow thinking.

## Models (as of 2026-10-10)
**TypeSafe Jev**
- Released 2026-09-15, in early access. Hosted, not local; available through OpenRouter and Cloudflare.
- Question types: Choice (up to 255 options), Score (against a rubric), and yes/no. Answers include the chosen option, probabilities and a confidence. Questions in one call are evaluated in parallel.
- Vendor-reported: 70–500 ms end to end; $0.042 per million input tokens, output free. On TypeSafe's own benchmark it's level with mid-tier frontier models and behind the top ones. Not independently verified.
- Sources: [docs](https://docs.typesafe.ai/introduction), [OpenRouter explainer](https://openrouter.ai/blog/insights/what-is-jev/), [Requesty explainer](https://www.requesty.ai/blog/typesafe-jev-explained)

**Microsoft-Decision-1**
- Announced 2026-10-09. Hosted on Microsoft Foundry, with OpenRouter support to follow.
- Pitched as fast and strong on structured decision tasks. Microsoft says it's testing it internally (incident response, quality control). No on-device version found.
- Sources: [Nadella on X](https://x.com/satyanadella/status/2108627923888754862), [Seeking Alpha](https://seekingalpha.com/news/4651845-microsofts-nadella-unveils-tech-giants-new-fast-decision-making-ai-model)

**Local small LLMs** (0.6–4B parameters, e.g. Qwen3, Gemma, Phi-4-mini, LFM2)
- Run with llama.cpp, vLLM or Ollama.
- You get the same choice-with-probabilities answer by reading token probabilities over the option labels instead of generating text.
- A ~300-token prompt with ~10 output tokens should run in roughly 50–150 ms on a GPU or Apple Silicon (rough estimate).
- They're also the only option here that could be fine-tuned. Jeeve doesn't train models ([[learning]]), so this matters only as a fallback if hosted models are unavailable.

## Caveats
- **Stateless:** each call sees one state, so time has to be encoded in it ([[perception]]).
- **Hosted models add network latency:** that limits them to about 2–5 decisions per second. Faster reactions need a local model or code underneath.
- **The probabilities are only as useful as their calibration,** and that's untested in a setting like a game.
