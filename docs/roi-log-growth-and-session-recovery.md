# ROI, log growth and session recovery

## Acceptance checklist

- [x] Explain fixed-capital ROI, arithmetic average return and expected log growth, including when rankings agree or differ.
- [x] Verify the current production selector and make an evidence-based KPI recommendation for this plugin.
- [x] Read the previous session directly and determine whether its agent needs takeover.
- [x] Research reported Codex terminal scrolling freezes and provide source-backed guidance. The user closed the frozen pane and explicitly changed this scope to web research only; no further local GUI diagnosis or repair is authorised.
- [x] Preserve the existing implementation and add regressions for any source corrections.
- [ ] Run every `npm test` suite and `npm run validate`; retain logs and exit codes.
- [x] Make the stop-loss recommendation and insurance cost understandable before the full 95-row detail list; cover the user's 2,328 / 656–2,221 USDT example and all locales.
- [ ] Deliver an updated Chrome package with clear update instructions, review all changes, commit locally and push once only after every task is closed.

## Session receipt

Direct `codex_tui.read_thread` inspection on 2026-10-02 found thread
`01a0fac8-065e-7611-b513-38dbe2f89ac2` idle. Its last turn
`01a0fcc6-1762-7c43-b13a-dcc73322223c` completed without error and reported
delivery of version 0.1.8 at commit `d548ad1`. At inspection, local Git also had
that commit as HEAD. No active turn from that session requires transfer. Source and
verification checks in this session independently assess the inherited work.

## Investigation boundary

The initial read-only process snapshot showed Ghostty, a Codex CLI terminal and
a separate Codex backend process. The user confirmed the affected surface was
terminal Codex and subsequently closed its frozen pane. The completed previous
thread was readable through the backend; UI responsiveness and agent execution
are separate observations. Its later status was `notLoaded`, with no active
turn to transfer.

Raw process dumps, session transcripts and crash reports remain local and
must not be committed or published because they can contain account data.
No TCC reset, permission database edit, session deletion or application restart
was performed. A read-only GUI snapshot failed with `Accessibility permission
not granted`. The permission request is withdrawn following the user's explicit
instruction to stop local computer operation and research online instead.

The source audit downgraded an input-mutex hypothesis: crossterm's zero-timeout
try-lock and background stdin reader can normally produce the observed stacks.
Only three CLI and two Ghostty effective samples were obtained, outside a
controlled scroll reproduction. No deadlock or root fix is claimed.

Comparable public CLI reports include [wheel-event backlog #48434](https://github.com/openai/codex/issues/48434),
[long-transcript rendering #21945](https://github.com/openai/codex/issues/21945),
and [macOS terminal TUI freeze #29368](https://github.com/openai/codex/issues/29368).
These are similar symptoms, not proof of the same cause here. Official
[Fullscreen/Scrollback guidance](https://github.com/openai/codex/discussions/49129)
provides `/tui` → Scrollback → restart. This is a supported mitigation, not a
verified repair of this user's incident. No local configuration was changed.

## Verification follow-up

The first full run failed the existing pagination test's 15-second real-time
watchdog; extension validation passed. That test mixed a termination assertion
with 61 real page-pacing delays and jittered backoff. Its isolated VM now records
the production delays while advancing sleeps asynchronously without real waits.
It retains the real watchdog, exact bounded retry count and backoff assertions;
production request pacing is unchanged. This removes host scheduling from the
logical pagination regression instead of increasing or bypassing its timeout.
Both the depth-limit case (6,100 of 45,108 rows retained, incomplete) and a
transient short-page recovery (all 250 rows retained exactly once, complete)
passed in the focused run; the full suite is still required before delivery.

The focused production-render-helper regression passed with the exact reported
money example, negative totals and baselines, zero differences, authoritative
optional selection and preserved 95 integer rows. All four locale dictionaries
match their generated runtime dictionary. An independent read-only review found
no scoring or execution-side-effect change; a stale optionality comment was
corrected to match the existing `optimal === null` check.

Full verification is running in retained PTY session `74419`, with PID recorded
in ignored `.codex/verification/clarity-run.pid`. Logs and eventual exit codes
are under `.codex/verification/clarity-*` and `clarity.receipt.json`. No repeat
run or push has been started. Before delivery, collect that original handle,
inspect the full test/validate/package receipt, rebuild the package if its bytes
precede the final comment correction, and run the prepared source/ZIP byte-parity
check. The pending package and final Git delivery are not yet complete.

## User-facing money explanation

The supplied SL-only history has a disabled-control aggregate price profit of
2,328 USDT. At 90% ROE, the enabled policy's total is 656–2,221 USDT, equivalent
to 107–1,672 USDT less profit than that control. Both endpoints are profits,
not maximum losses or a bill payable when the stop fires. At 1%, the total
134–4,145 USDT instead spans 2,194 less profit to 1,817 more profit. Keep both
readings; do not label a baseline-crossing range as only a cost or only a gain.

The headline says the historical optimum is no stop; 90% is the conditional
best enabled stop under the conservative price objective for this supplied
SL-only result. The joint TP/SL optimum is a separate result. Four locales now
show the answer, aggregate money and control-relative difference before the
collapsed technical explanation and full integer profile. Negative totals and
negative baselines use loss/general PnL wording, and exact PnL ties are not
described as an insurance cost. These are historical model results, not future
optimality, a personal copier profit estimate or an account loss guarantee.

## What the plugin actually optimises

The joint selector uses `argmax_policy min_reading sum_position price_PnL`.
All candidates use the same admitted positions and entry quantities. A supplied
positive fixed capital only converts the monetary output into a percentage; it
does not affect ranking. The browser currently supplies no verified initial
capital, so ROI percentages remain null. Costs, funding, liquidation, capital
availability and execution uncertainty prevent calling this executable net ROI.

The old 0.1.7 formula was the average of
`log(1 + position_price_PnL / baseline_equity_at_entry)`; equity availability
automatically changed the objective. The current selector does not do this.
This follow-up corrects its remaining joint metadata from `priceROI` to
`pricePnl` and `historicalPricePnl`, without changing monetary scores. Regression
checks cover missing capital and capital of 1,000 and 1,000,000, including all
optimal ties and the absence of invented ROI when the denominator is unknown.

## Three mathematical distinctions

With no external cash flows, initial account equity W0 and final equity WT,
`ROI = WT/W0 - 1`. For the same capital, period and feasible account path,
maximising ROI and maximising `log(WT/W0)` have exactly the same optimum:
logarithm is strictly increasing. If each r_t is the actual return of that
candidate's whole account, `sum log(1+r_t) = log(WT/W0)`. At a fixed duration,
maximising CAGR also gives the same ordering. This identity requires positive
wealth and cash-flow-adjusted account returns; it is not a multiplication of
overlapping position ROEs.

Different criteria arise when comparing expected monetary return with expected
log utility under uncertain future outcomes. In a hypothetical single-period
example, A has equal probability of +100% and -50%; B earns a certain +10%.
Expected ROI is +25% for A and +10% for B, but expected log growth is zero for A
and `log(1.1) = 0.09531` for B. Log utility favours B. Under suitable repeated
fractional-allocation and distribution assumptions, this targets long-run
geometric growth. It does not itself guarantee a maximum drawdown or that the
estimated distribution remains valid. A possible total account loss makes log
utility negative infinite, rather than a loss to be clipped away.

Arithmetic average trade return also differs from compounded account ROI.
Hypothetical successive account returns +80%, -50% average +15%, but compound
to `1.8*0.5-1 = -10%`. Two +10% periods average +10% and compound to +21%.
True compounded ROI already prefers the second path; this is not evidence that
ROI is intrinsically worse than a logarithm. If each trade instead uses a fixed
100-unit stake, their additive profits are 30 versus 20 units: changing the
sizing model changes the question.

The old per-position log score is not a whole-account growth curve. Consider
two simultaneous positions sharing capital 1,000. Policy A earns +800 and -400,
ending at 1,400 (+40%). Policy B earns +150 and +150, ending at 1,300 (+30%).
The surrogate score sums to `log(1.8)+log(0.6) = 0.07696` for A and
`2*log(1.15) = 0.27952` for B, incorrectly interpreting simultaneous positions
as separate multiplicative account periods if labelled compound growth. It is
a different utility preference, not a calculation of those terminal ROIs.
Historical baseline equity is also not automatically the counterfactual equity
after a candidate stop has changed earlier outcomes.

## KPI recommendation

For the user's stated task, retain aggregate historical PnL/ROI at a common
capital base and entry sizing as the explicit primary objective. Do not replace
it with hidden per-position log utility. Also report drawdown, tail losses,
sample coverage, cost sensitivity and fixed-choice chronological holdout, rather
than treating a high in-sample ROI as a validated future recommendation.

For a future system that actually reconstructs the copier's chronological net
account equity, expected log growth is a useful objective for sustained capital
growth. That requires the candidate's own sizing, simultaneous exposure,
available margin, fees, funding and liquidation model, as well as untouched
out-of-sample evidence. Risk constraints must be explicit and empirically
supported. The present public price model cannot establish these missing facts
by changing its KPI label.

Mathematical reference: [Sun and Boyd, Distributional Robust Kelly Gambling](https://web.stanford.edu/~boyd/papers/pdf/robust_kelly.pdf).
See also [Sharpe, Multi-period Returns](https://web.stanford.edu/~wfsharpe/mia/rr/mia_rr3.htm).
