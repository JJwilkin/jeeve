---
date: 2026-10-10
tags: [research, prior-art, system-1, system-2, distillation]
status: active
---
# PEAM (Parametric Embodied Agent Memory)

Source: Guo et al., May 2026, [arXiv 2605.27762](https://arxiv.org/html/2605.27762) (preprint, no venue). All numbers are self-reported.

The closest published match to Jeeve's fast/slow split ([[overview]]). A slow frontier LLM does the reasoning. Its verified successes, and its corrections of failures, are periodically trained into a small fast model that then handles those skills on its own. It runs over Mineflayer, not pixels. It partly fills the gap [[fast-slow-agents]] calls "largely unexplored", though at small scale. Part of the [[sota-minecraft-agents]] survey.

## How it works
- **Slow tier:** GPT-4o. It proposes the curriculum, writes code, verifies, and judges outcomes. The setup is Voyager's ([[mindcraft-and-voyager]]).
- **Fast tier:** Qwen3-VL-8B-Instruct with a **mixture-of-experts LoRA**: one isolated adapter (~83M parameters) per skill category (craft, gather, combat). It **generates executable Mineflayer JS**, which a verifier checks. The paper doesn't say whether its input is screenshots, text state or both.
- **Escalation:** control goes back to the slow tier when no consolidated skill applies, or when the fast tier's output fails verification. A DistilBERT router with threshold 0.6 is listed in the hyperparameters, but the text doesn't tie it to the fallback.
- **What gets internalized:** a parameterization-worthiness score,
  `PV = 0.4·U_cost + 0.3·U_stab − 0.2·P_redun − 0.1·R_forget`, where:
  - `U_cost` is expected call frequency × code length,
  - `U_stab` is success rate × consistency across contexts,
  - `P_redun` is similarity to skills already consolidated,
  - `R_forget` flags whether the skill shares a category with one already parameterized.
- **When:** a self-triggered test fires when a skill's recent failure rate (last 10 runs) is significantly above its baseline (two-proportion z-test, α = 0.05), and its PV is in the top half.
- **Training:** behavioral cloning on verified successes, plus a DPO contrastive term on failure → correction pairs. 100 steps, LoRA rank 32.

## Results
11 held-out tasks (craft table up to iron pickaxe, logs, cobblestone, iron, coal, zombie, skeleton), 3 seeds, so 33 trials per method:

| Method | Success |
|---|---|
| Voyager | 54.5% |
| Optimus-1 (replication) | 60.6% |
| **PEAM** | **69.7%** |

| | PEAM | Voyager | Optimus-1 rep. |
|---|---|---|---|
| Median latency per call | 3.2 s | 5.5 s | 6.1 s |
| Tokens per task | ~4.6K | ~31.2K | ~28.4K |

Per category (summed from the appendix): craft 80% vs Voyager 60%, gather 75% vs 58%, combat 33% vs 33%. Both fail "defeat a skeleton with a bow".

## Ablations
| Change | Effect |
|---|---|
| One shared LoRA instead of per-category experts | Forgetting 0% → 32.4% over two consolidations |
| EWC / naive full fine-tune instead | Forgetting 43.3% / 78.5% |
| Drop the behavioral-cloning term (DPO only) | Format-correct outputs 12/12 → 0/12 |
| Heuristic instead of PV score | Task success −8.7 points |
| Fixed schedule instead of self-triggered | 37% more cycles to reach the same performance |

## Caveats
- **Tiny evaluation:** 33 trials, early-game tasks only. The gap over Voyager is 5 tasks.
- **Not real time.** The paper doesn't say whether the game pauses. It inherits Voyager's code base, which pauses the server while the LLM thinks ([[sota-minecraft-agents]]). A 3.2 s median call is still far too slow for the decisions [[decision-models]] targets.
- **The fast tier still writes code** rather than picking actions. It's a cheaper slow model, not a reflex.
- **Navigation stays with the slow tier.** Only three hand-picked categories exist, and adapters grow linearly with categories.
- **Inconsistencies:** the appendices disagree on serving hardware (1 vs 8 A100s). The text says PEAM "matches or exceeds" Voyager on 10 of 11 tasks, while its own table shows all 11.

## Takeaways for Jeeve
- **The distillation loop works at small scale over Mineflayer.** A frontier model generates, a verifier or judge filters, and a small model is trained on the result. Cost per task fell ~7x in tokens. That is evidence for the "fine-tuned weights" branch of [[overview]]'s open question on what form distillation takes.
- **Train on corrections, not just successes.** The failure → fix contrastive pairs are cheap to get from traces. In Jeeve they come from Judgment spans where slow thinking overrode or repaired a fast decision.
- **Isolate what's learned by category** to avoid forgetting. One shared adapter forgot a third. For Jeeve's fast model this argues for per-domain adapters (combat vs building vs gathering), or at least replay.
- **When to distill is itself decided by data.** PV and the failure-rate trigger are a discovery-friendly answer to "when do we retrain", not a fixed schedule. But the PV weights were grid-searched and fixed.
- **What PEAM doesn't answer:** a fast model that picks *actions* (options) several times a second in a live world, which is Jeeve's System 1. PEAM's fast tier sits one level up, at "write the skill".
