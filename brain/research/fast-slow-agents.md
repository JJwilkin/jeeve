---
date: 2026-10-10
tags: [research, prior-art, system-1, system-2]
status: active
---
# Fast/slow agents: prior art

Agents that split a slow reasoning planner from a fast controller. This is the background for the fast and slow split in [[overview]].

## In Minecraft
- **Optimus-3** ([arXiv 2506.10357](https://arxiv.org/pdf/2506.10357)):
  - Explicitly splits System 1 (the fast loop from seeing to acting) from System 2 (planning and reflection).
  - Argues one dense model can't serve both well. Its answer is a mixture-of-experts model with two routers.
- **WISE** ([arXiv 2606.12852](https://arxiv.org/html/2606.12852v1)):
  - An LLM planner produces subgoals, and a low-level controller carries them out.
  - It compares itself against MrSteve, from the STEVE-1 family of learned controllers that act from pixels.
- **From memory, not re-checked in this pass:**
  - **VPT:** OpenAI's model that plays from video.
  - **STEVE-1:** a pixel controller that follows instructions, built on VPT.
  - **ROCKET-1:** a vision-language planner over a pixel controller.
  - **GITM:** breaks goals into subgoal trees.
  - **JARVIS-1:** keeps plans that worked and retrieves them later.
  - **DEPS:** describe, explain, plan, select; replans when something fails.

**Gap:** these systems pair a planner with a *learned pixel controller*. Using a small LLM or decision model ([[decision-models]]) over *structured* game data ([[perception]]) as the fast layer, orchestrated by a frontier model, seems largely unexplored.

## Outside Minecraft
- **DualVLN, "Ground Slow, Move Fast"** ([arXiv 2512.08186](https://arxiv.org/html/2512.08186), ICLR 2026): navigation.
  - A large vision-language model reasons slowly and outputs intermediate goals.
  - A lightweight diffusion policy turns those goals into trajectories.
- **Fast-in-Slow** ([arXiv 2506.01953](https://arxiv.org/pdf/2506.01953)): robot manipulation. Reuses the last layers of a vision-language model as the fast module.
- Other robotics models split the same way: a slow reasoning model running a few times a second over a fast motor policy.

## Search and learning in one loop
AlphaZero is the template for how fast and slow should relate under the [[bitter-lesson]]:
- tree search (slow) produces better moves than the network alone,
- the network (fast) is trained to imitate them,
- and a better network makes the search stronger.

Machine learning calls this *expert iteration*. In Jeeve, slow thinking plays the search role and fast thinking is the network being trained.
