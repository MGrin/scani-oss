---
title: Dependency injection pattern
description: Class-field initialisers with Container.get(...). Constructor injection silently breaks under Bun.
sidebar:
  order: 3
---

## The rule

In any `@Service()`-decorated class, **use class-field initialisers
with `Container.get(Dep)`**. Do NOT use constructor-param injection.

```ts
// ✅ Correct
@Service()
export class MyService {
  private readonly repo = Container.get(MyRepository);
  private readonly other = Container.get(OtherService);
  // No constructor — or `constructor() {}` if you need a hook
}
```

```ts
// ❌ Wrong — silently broken at runtime
@Service()
export class MyService {
  constructor(
    private readonly repo: MyRepository,    // typedi injects ContainerInstance here
    private readonly other: OtherService,   // same
  ) {}
}
```

```ts
// ❌ Also wrong — `= Container.get(...)` defaults do NOT fire
@Service()
export class MyService {
  constructor(
    private readonly repo: MyRepository = Container.get(MyRepository),
  ) {}
}
```

## Why

Bun's TypeScript transpiler does not emit `design:paramtypes`
reflect-metadata for decorators. typedi's constructor-param
injection relies on that metadata; when it's missing, typedi falls
back to injecting its own `ContainerInstance` into every slot.

The field "exists" but is actually the typedi container itself.
You then get runtime errors like `this.foo.someMethod is not a
function` the first time you call a method on the "injected"
dep. Tests pass (they `new Service(stub)` directly), production
breaks. The worst kind of footgun.

Full design rationale:
[Why class-field DI, not constructor injection](/decisions/class-field-di/).

## The testing pattern

Class-field initialisers run during construction and read from the
container at construct time. To stub a dep:

```ts
function makeService(stubDep: Dep): MyService {
  Container.set(MyRepository, stubDep);   // seed the container BEFORE
  const instance = new MyService();        // class-field initialisers run NOW
  Container.set(MyService, instance);      // register the result
  return instance;
}
```

**Don't** call `Container.reset()` or
`Container.remove(MyService)`. Either wipes the `@Service()`
registration and breaks subsequent resolutions of the *real*
service.

**Order matters.** Stub the dep before `new MyService()`. Setting
it after the construction won't help — the class-field initialiser
has already read the previous value (real or undefined).

Canonical examples:
- `packages/business/domain/tests/services/HoldingService.test.ts`
- `packages/business/domain/tests/services/BalanceAtTimeService.test.ts`
- `packages/business/domain/tests/services/PriceGraphService.test.ts`

## A few more rules of thumb

- **Don't pass deps to constructors at all.** Even for tests. If
  you need a non-DI dep (a config value, a date), set it via a
  setter or read it from the container.
- **Don't lazy-`Container.get(...)` inside methods.** Field
  initialisers run once at construction; method-level reads run on
  every call. Method-level reads also make the dependency invisible
  to readers — the field on the class is the contract.
- **`@Service()` is required.** A class without the decorator isn't
  in the container; `Container.get(Class)` on it will throw.

## See also

- [Engineering conventions](/contributing/conventions/)
- [Testing patterns](/contributing/testing/)
- [Why class-field DI, not constructor injection](/decisions/class-field-di/)
