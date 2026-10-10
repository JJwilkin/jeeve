---
date: 2026-10-10
tags: [research, prior-art, system-1, system-2, concurrency, multi-agent]
status: active
---
# Project Sid (PIANO)

Source: Altera, "Project Sid: Many-agent simulations toward AI civilization", [arXiv 2411.00114](https://arxiv.org/html/2411.00114v1) (Oct 2024). Precursor: Lyfe Agents, [arXiv 2310.02172](https://arxiv.org/html/2310.02172), from the same group.

The best-known LLM agent design built around **thinking and acting at the same time** in Minecraft, at a scale of 10 to 1000+ agents. It's the closest prior art to [[overview]]'s rule that the world doesn't pause. Its contribution is architectural: concurrent modules plus a single decision bottleneck. The paper is thin on mechanism and numbers, and every result is self-reported.

## The problem it names
Two problems, both from §1.3 and §2 of the paper:
- **Real time.** Agents must "respond with minimal latency" to humans. "Single-threaded design assumes that the agent performs a single task at a given time", and "sequential design assumes that all modules operate at similar time scales." Slow processes "should not block agents from responding to immediate threats" (§2.1).
- **Coherence.** Once modules run in parallel, "they can produce independent outputs, making the agent incoherent" (§2.2).
  - The paper's example: a chat module says "Sure thing!" while a separate function-calling module picks "explore".
  - Producing talk and action from one LLM call fixes this, but the paper says that doesn't scale ([§1.3](https://arxiv.org/html/2411.00114v1)).

## How PIANO works
PIANO stands for "Parallel Information Aggregation via Neural Orchestration". The name is expanded slightly differently in the abstract and in §2.

**1. Concurrency (§2.1)**
- Each module is "a stateless function that reads and writes to a shared Agent State."
- Modules run "concurrently and at different time scales". The paper's examples:
  - **Reflexes** use "small, fast non-LLM neural networks".
  - **Goal generation** does slow "deliberate reasoning over graphs".
  - **Social modules** run only during social interactions.
- The only cadences given: social goals every 5–10 s (§5.1) and taxation signals every 120 s (§5.2).

**2. Coherence through a bottleneck (§2.2)**
- The **Cognitive Controller (CC)** is "solely responsible for making high-level deliberate decisions."
  - **Bottleneck:** it reads a *filtered subset* of the Agent State. Designers choose what gets through. Social information, for example, always passes the bottleneck.
  - **Broadcast:** its decision is sent to the output modules and "is used to strongly condition the talk-related modules." Talk stays consistent with action because both follow the same decision.
- The analogy is the brain. The paper cites split-brain patients, where cutting the link between hemispheres causes incoherence.
- **No concrete CC outputs are given.** The paper never shows an example decision, such as "go mine iron".

**3. Modules (§2.3)**
The paper says there are about 10 modules but names six:

| Module | What the paper says |
|---|---|
| Memory | "Stores and retrieves conversations, actions, and observations across various timescales." Figure 3 shows working, short-term and long-term memory. |
| Action Awareness | "Allows agents to assess their own state and performance." §3.2 adds that it compares "expected action outcomes with observed outcomes." |
| Goal Generation | "Facilitates the creation of new objectives based on the agent's experiences and environmental interactions." |
| Social Awareness | "Enables agents to interpret and respond to social cues from other agents." |
| Talking | "Interprets and generates speech." It's conditioned by the CC. |
| Skill Execution | "Performs specific skills or actions within the environment." |

- **The skill interface isn't described.** The paper doesn't say whether skills are hand-coded functions over a protocol bot like Mineflayer ([[perception]]). We assume they are, but that's unverified.
- **Models:** GPT-4o. The paper says older base models couldn't reach the same progression (§3.2). Election prompts in the appendix use `gpt-4o`, and the vote tally uses `gpt-4o-mini`. Figure 13 compares base models, including an old Claude 3.5 Sonnet snapshot, but only as a figure.

**What's missing:** latency figures, how often most modules run, how memory is stored or retrieved, LLM calls per agent, and cost. **No code was released.** The [GitHub repo](https://github.com/altera-al/project-sid) holds only the PDF and a video.

## Lineage: Lyfe Agents
The CC and the memory design come from Lyfe Agents ([arXiv 2310.02172](https://arxiv.org/html/2310.02172)), which gives more mechanism:
- **Option-action framework.**
  - The CC makes one LLM call that returns an *option* (e.g. talk) plus a subgoal.
  - An action module then picks the concrete actions within that option.
  - Options end through "fast, non-LLM methods": a timer, or repetition detection for conversations.
  - Without this, the CC runs every step. In the ablation, conversations ended about 3× sooner (about 24 s vs. 70 s).
- **Asynchronous self-monitoring.**
  - A slow LLM loop keeps a running narrative summary of recent events, weighted toward what's novel or relevant to goals.
  - It runs off the action path, triggered by new observations, and feeds the action prompts. One agent's summary was updated 35 times in a run.
- **Summarize-and-Forget memory.**
  - Working memory holds about 4–5 items.
  - Short-term memory holds the self-monitor's summaries.
  - Long-term memory is built by clustering and summarizing, then dropping items too similar to an incoming one (a threshold θ, value not given).
- **Cost (self-reported):** about $0.50 per agent per hour on GPT-3.5, against an *estimated* $25 for Generative Agents. The paper's own ratio is inconsistent: "10–100×" in the abstract and "30–100×" in the introduction.

## Results
All self-reported, from a preprint with no independent replication found.

| Experiment | Scale | Result |
|---|---|---|
| Item progression (§3.2) | 25 agents, 30 min | Average of 17 unique items, top agents 30–40. Removing action awareness lowered progression (no number given). |
| Long run (§3.2) | 49 agents, 4 h | Unique items saturate at about 320, roughly a third of all items. Diamonds by about 30 min. |
| Specialization (§5.1) | 30 agents, 20 min | Roles emerge (farmer, miner, guard, …). Without social modules, roles are uniform and don't persist. |
| Collective rules (§5.2) | 25 constituents + 3 influencers + 1 election manager | Agents vote to change the tax law, and tax paid follows it: about 20% falls to about 9% after a cut to 5–10%. A frozen constitution keeps tax paid constant. |
| Culture (§5.3) | 500 agents, 6 towns, 9,000 s | Memes and a parody religion spread. More memes in towns than in rural areas, per capita. |

- **1000+ agents** "exceeded the computational constraints of our Minecraft server", which made agents sporadically unresponsive. The culture analysis therefore uses the 500-agent run (§5.3).
- The ~320-item ceiling is a *population* result. No single agent got near the tech tree depth that [[gitm]] reports.

## Failure modes and limitations
- **Hallucinations compound.** "Even a small rate of hallucinations can poison downstream agent behavior." In a group they spread socially from agent to agent (§1.3). The paper gives no rates.
- **Incoherence** between output streams was the motivating failure. The paper doesn't measure how often the CC still misses it.
- **No vision or spatial reasoning,** which limits navigation and building (§7).
- **Weak innate drives:** no robust survival, curiosity or community drive (§7).
- **The infrastructure was the limit,** not the agents: the Minecraft server, at over 1,000 agents.

## Caveats
- It's a technical report from a company, with no code, no latency numbers and no cost figures. The architecture is described at the level of a diagram.
- **The benchmarks are social and civilizational, not competence.** Nothing measures reaction time, combat, or how fast an agent responds to a threat, which is the problem concurrency was meant to solve.
- Altera rebranded as Fundamental Research Labs and moved to desktop agents in May 2025 ([announcement](https://digitalhumanity.substack.com/p/introducing-fundamental-research)). There's been no follow-up Minecraft work, as far as we found.

## Takeaways for Jeeve
- **Concurrency plus one decision-maker is the core idea, and it maps onto [[overview]].**
  - PIANO's CC plays the role of Jeeve's System 2, deciding what to commit to.
  - Its reflex modules are Jeeve's 20 Hz code layer.
  - **PIANO has no learned fast-decision layer between the two.** Jeeve's System 1 is new relative to PIANO.
- **Adopt the bottleneck-and-broadcast rule.** Every output stream (movement, chat, combat stance) should be conditioned on the same current commitment, so the agent can't say one thing and do another.
  - In Jeeve, the commitment is the active node in the goal tree.
  - Only System 2 writes new goals. System 1 and code read the goal and write to its log.
- **The shared state is the interface.**
  - PIANO's modules communicate only through a shared Agent State, never by calling each other. That's what lets them run at different speeds.
  - For Jeeve, the goal tree plus a world-state blackboard can play this role. System 2 writes directives into it, and System 1 and code read the latest version without waiting.
- **Action awareness is an escalation signal.** Comparing what the agent expected with what happened is cheap and measurable, and it improved progression. A gap between expected and observed is a natural "surprised" trigger for handing back to System 2.
- **Lyfe's option-action design is Jeeve's "options" ([[overview]]).** Have the slow model choose an option. Let cheap code detect when it terminates. Don't call the LLM again until it does.
- **Social and multi-agent behaviour is a separate axis.** If Jeeve plays Bed Wars with teammates, a social module that reads chat and tracks sentiment would need to share the same bottleneck.
- **Through the [[bitter-lesson]] lens:** PIANO's modules and skills are hand-designed, and nothing is learned from experience. Lyfe's memory is closer to discovery, but by summarizing, not learning.
