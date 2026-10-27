# Development Guidelines

- Biased toward caution over speed. Use judgment for trivial tasks.


## 1. Core Beliefs

- **Incremental progress over big bangs** — Small changes that compile and pass tests
- **Learning from existing code** — Study and plan before implementing
- **Pragmatic over dogmatic** — Adapt to project reality
- **Clear intent over clever code** — Be boring and obvious

## 2. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 3. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 4. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it — don't delete it.
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

**The test: Every changed line should trace directly to the user's request.**

## 5. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 6. Planning & Staging

Break complex work into 3-5 stages. Document in `IMPLEMENTATION_PLAN.md`:

```markdown
## Stage N: [Name]
**Goal**: [Specific deliverable]
**Success Criteria**: [Testable outcomes]
**Tests**: [Specific test cases]
**Status**: [Not Started | In Progress | Complete]
```

- Update status as you progress
- Remove file when all stages are done

## 7. Implementation Flow

1. **Understand** — Study existing patterns in codebase
2. **Test** — Write test first (red)
3. **Implement** — Minimal code to pass (green)
4. **Refactor** — Clean up with tests passing
5. **Commit** — With clear message linking to plan

## 8. When Stuck (After 3 Attempts)

**CRITICAL: Maximum 3 attempts per issue, then STOP.**

1. **Document what failed**: What you tried, specific error messages, why you think it failed
2. **Research alternatives**: Find 2-3 similar implementations, note different approaches
3. **Question fundamentals**: Is this the right abstraction level? Can this be split? Is there a simpler approach?
4. **Try different angle**: Different library/framework feature? Different architectural pattern? Remove abstraction instead of adding?

## 9. Architecture Principles

- **Composition over inheritance** — Use dependency injection
- **Interfaces over singletons** — Enable testing and flexibility
- **Explicit over implicit** — Clear data flow and dependencies

## 10. Error Handling

- Fail fast with descriptive messages
- Include context for debugging
- Handle errors at appropriate level
- Never silently swallow exceptions

## 11. Decision Framework

When multiple valid approaches exist, choose based on:

1. **Testability** — Can I easily test this?
2. **Readability** — Will someone understand this in 6 months?
3. **Consistency** — Does this match project patterns?
4. **Simplicity** — Is this the simplest solution that works?
5. **Reversibility** — How hard to change later?

## 12. Project Integration

### Learning the Codebase
- Find 3 similar features/components
- Identify common patterns and conventions
- Use same libraries/utilities when possible
- Follow existing test patterns

### Tooling
- Use project's existing build system
- Use project's test framework
- Use project's formatter/linter settings
- Don't introduce new tools without strong justification

## 13. Quality Gates

### Definition of Done

- [ ] Tests written and passing
- [ ] Code follows project conventions
- [ ] No linter/formatter warnings
- [ ] Commit messages are clear
- [ ] Implementation matches plan
- [ ] No TODOs without issue numbers

### Test Guidelines

- Test behavior, not implementation
- One assertion per test when possible
- Clear test names describing scenario
- Use existing test utilities/helpers
- Tests should be deterministic

### Every Commit Must

- Compile successfully
- Pass all existing tests
- Include tests for new functionality
- Follow project formatting/linting
- Commit message explains "why"

## 14. Important Reminders

**NEVER**:
- Use `--no-verify` to bypass commit hooks
- Disable tests instead of fixing them
- Commit code that doesn't compile
- Make assumptions — verify with existing code

**ALWAYS**:
- Commit working code incrementally
- Update plan documentation as you go
- Learn from existing implementations
- Stop after 3 failed attempts and reassess

---
**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
