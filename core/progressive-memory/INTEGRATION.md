# Progressive Memory Integration

## Context Isolation

The additional runtime authorization system was deferred from 2.4.1 on
2026-10-18. This module no longer initializes, imports or requires that system.
Existing module eligibility, table ownership, group rules, selected columns and
the feature's own enable/consent settings remain enforced.

`context-guard.js` captures the current chat, card, table revision and relevant
memory configuration. It rejects stale work across asynchronous reads and before
publication without introducing a new source/target approval workflow. It does
not hash the entire settings object or expose credentials in diagnostics.

Local previews do not send model requests or mutate saved rules. Generation
leases and prompt cleanup protect chat isolation and budget integrity; they do
not claim control of arbitrary host or third-party network requests.

## Index Dependencies

`rule-dependencies.js` exports:

```js
readProgressiveMemoryRuleDependencies({ tableId, indexId, groupId } = {})
collectProgressiveMemoryRuleDependencies(progressiveSettings, query = {})
```

Both are synchronous and read-only. The first reads
`extension_settings[extensionName].progressive_memory`; the second accepts that
subtree, not the full settings object. They return a frozen array of frozen
`{ groupId, ruleId, ruleRevision, tableId, indexId }` records. Dependencies come from
enabled rules at `memoryRules.rules[].trigger.conditions[].indexId` and their
`trigger.tableId`. A repeated condition may return the same dependency twice.

Disabling the master progressive/rules switch or clearing egress consent does not
release dependencies. Explicitly disable or remove each affected rule to release
it. Invalid persisted dependency structure throws
`PROGRESSIVE_RULE_DEPENDENCIES_INVALID`; never treat that as an empty dependency
list. The parent index editor should re-read after confirmation and immediately
before its existing durable transaction, retaining its original scope/CAS checks.
These helpers neither approve an index edit nor disable rules for the caller.

## Generation And Consumers

`generation-host.js` exports `beginCurrentMemoryGeneration(type)`,
`assertCurrentMemoryGeneration()` and `endCurrentMemoryGeneration()`.
Begin is asynchronous and must finish before the early memory-block injection
and `WORLDINFO_ENTRIES_LOADED`. Start once, not once per interceptor. The shared
handle survives the interceptor through final worldbook prompt assembly.
Assert after the index-worldbook finalizer on both mutable final prompt events.
End on completion, cancellation and chat transition; await cleanup where the
host event supports it. Failed revocations remain latched and block the next begin.
Do not silently start a replacement generation after an in-flight one went stale.
Quiet/dry-run operations are not separate participating memory generations;
nested host `Generate('quiet')` is not a supported reentrant parent lifecycle.
The current preset service uses direct request services rather than `Generate`.

`consumer-host.js` installs read-only rules in separate user-role prompt keys.
`memoryRules.consumer` chooses `progressive`, `memory-blocks` or `super-memory`;
unknown destinations invalidate execution while retaining raw configuration.
The production `injectMemoryBlockChain` wrapper calls this adapter. Repeating
that wrapper in the same generation reuses a still-current committed rule result
without clearing its prompt, charging twice or dropping coverage. The existing
base memory-block pipeline remains independent. The parent unified entry calls
`injectSuperMemoryRules(type)` from `core/super-memory/manager.js` after the other
memory consumers. SuperMemory permission/settings are checked independently.

`generation-exchange.js` exposes opaque generation handles, exact source keys,
`prepareMemoryContribution`, and `memoryGenerationStatus`. A prepared contribution
must be settled by `commit()` only after actual installation, or `release()` in a
finally block. Reservations serialize; abandoned reservations claim no coverage.
Every contribution supplies currentness and an actual output-revocation callback.
Candidates are admitted whole with the real tokenizer on their complete rendered
contribution. The shared limit sums participating contributions, not arbitrary
legacy worldbooks, base memory blocks, old SuperMemory output or all host overhead.
First committed content wins exact source overlap; candidate enumeration is not
evidence that a worldbook entry entered the final prompt. Ampere's index adapter
commits only complete owned blocks found in the actual mutable final payload.

## Macro Ledger Coverage

The trusted writer calls `captureLedgerCoverageSource(getContext, endFloor)` before
reading/generating the claimed source interval (floors 1 through endFloor). After
the product completes, `createLedgerCoverageReceipt(token, exactGrandScroll)` binds
it to the unchanged source evidence. Persist the returned object under
`PROGRESSIVE_LEDGER_COVERAGE_KEY` (`amilyProgressiveCoverage`) on the same book draft
and durable transaction as the product. The historian writer now mounts this
through `ledger-producer.js`: complete unchanged micro input establishes a bounded
continuous input receipt, and both rolling/segmented macro writers derive from it.
The optional trusted `prepareDraft` callback in segmented-runtime runs after the
revision journal and before the same strict persistence, not in a second save.
Unknown old input, gaps, filtered/edited input and over-limit evidence preserve
the ordinary summary without certifying coverage. Explicit chat/card transfer
rebuilds entries without copying these root-level receipts.
Do not retroactively certify an old macro or independently save its receipt.

The reader validates product hash, source evidence scheme, chat ownership,
floor range and message hashes. Missing receipt means unknown coverage, not an
invented range. Invalid receipts suppress the stale macro. A truncated product
can still be injected within budget but claims no full-range coverage. Verified
compaction candidates translate their durable message identities to that same
chat-floor evidence, permitting exact macro/compaction overlap suppression.

## Final Preview And Source Selection

The rule GUI calls the real `previewProgressiveMemoryRule` engine: its
`budgetPreview` contains the complete local consumer prompt, host-tokenizer cost,
coverage, exclusions and diagnostics, with no send/save or grant mutation.
It is not a prediction of future worldbook activation or an all-host prompt total.
Locale refresh retains the existing inputs, pending preview and confirmation.

Source projection follows the configured table/column selection and existing
module/group eligibility. Receipt verification still validates the complete
stored evidence instead of mistaking projected data for an integrity proof.
Unknown identity is not fabricated; context and configuration changes invalidate
pending work. No independent sourceAccess approval catalog is required.

## Focused Evidence

`tests/progressive-memory/context-isolation.test.mjs` checks context changes with
offline host adapters. The durable receipt integration uses
the production fill/compaction bodies and an offline transport. These tests are
not real-client acceptance, a whole-plugin security review, or a deployment.
