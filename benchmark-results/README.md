# Benchmark: does the brain help a model answer questions about *your* codebase?

## The experiment

A coding model can't know a team's own rules: their API versioning scheme, how they store money, which
logging library they use. duker-brain is meant to fill that gap by routing the one note that applies
into the prompt. This benchmark checks whether it does.

- **The brain:** a vault for *Kestrel*, an invented freight-logistics company. It has 32 notes in 8
  folders (api, data, observability, testing, deploy, security, jobs, workflow). The rules sound
  plausible but usually differ from the common industry default, so the model can't guess them.
- **The questions:** 160 multiple-choice house-rule questions, 5 per note, worded the way a developer
  would ask them and without copying the note's wording. Each has four choices, and one wrong choice is
  always the industry default. There are also 30 general programming questions as a control.
- **Fairness checks:** choices are matched in length and style. Answering rules that know nothing about
  Kestrel (pick the longest, the shortest, the one with most word overlap) all score close to chance (21–26%).
- **Models:** answer model `Qwen/Qwen3-8B-AWQ`, decision model JEV-9B (Q6_K, llama.cpp). Scoring uses
  0-shot next-token log-probabilities of A/B/C/D at temperature 0.
- **Conditions:** the prompts are identical except for the reference block after the question.

| Condition | Reference block |
|---|---|
| baseline | nothing: the model on its own |
| brain | the note duker-brain's router picks (gate off, so it always routes) |
| oracle | the note the question was written from: perfect routing, the ceiling |
| all-notes | every note in the brain: the "one big system prompt" alternative |

## Results

House-rule questions (n = 160, chance = 25%):

| Condition | Accuracy | Δ vs baseline | Picked the industry default | Prompt tokens / question |
|---|---:|---:|---:|---:|
| baseline | 43.1% | – | 21.2% | 133 |
| **brain** | **63.7%** | **+20.6 pp** (95% CI +13.8 to +27.5, McNemar p < 0.001) | 10.0% | 501 |
| oracle | 65.6% | +22.5 pp | 9.4% | 476 |
| all-notes | 48.1% | +5.0 pp (not significant) | 20.0% | 11,465 |

What the numbers show:

1. **The brain gets close to the ceiling.** The router delivered the exact right note for 86% of
   questions and captured 92% of the gain that perfect routing gets.
2. **Routing beats putting everything in the prompt.** Pasting the whole brain into the prompt only
   reaches 48.1% while using about 23× the tokens. The model gets lost in the extra text.
3. **The gain comes from the right note, not from extra text.** A random note from another folder gives
   45.6% (+2.5 pp, p = 0.45), which is no better than having no note.
4. **It is fast.** Routing takes 167 ms at the median and 228 ms at worst, well under the 1 s budget.
5. **It does no harm.** Accuracy on the 30 general programming questions stays at 96.7% in every condition.

> With the defaults this run used (gate threshold 0.5), the gate was too conservative: it skipped 83% of house questions, so
> the default setup gains only +4.4 pp (p = 0.016). When the gate does let a note through, accuracy on
> those questions rises from 39% to 70%. The gate separates house questions from general ones well
> (AUC 0.97). A threshold of 0.2 instead of 0.5 would let 91% of house questions through and only 10%
> of general ones, so the default is now 0.2. It has not been re-benchmarked yet.

Setup: repository commit `e3665b3`, run 2026-10-09.
