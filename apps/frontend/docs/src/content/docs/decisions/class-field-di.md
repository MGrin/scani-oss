---
title: Why class-field DI, not constructor injection
description: Bun's TypeScript transpiler doesn't emit decorator paramtypes metadata. Constructor injection silently fails; class-field initialisers don't. This is a runtime constraint, not a style choice.
sidebar:
  order: 7
---

## The decision

Every `@Service()`-decorated class in this repo uses **class-field
initialisers** with `Container.get(Dep)` to resolve dependencies:

```ts
@Service()
export class MyService {
  private readonly repo = Container.get(MyRepository);
  private readonly other = Container.get(OtherService);
}
```

**Constructor-parameter injection is forbidden.**

## The alternative we rejected

The idiomatic typedi pattern from Node + TypeScript projects:

```ts
@Service()
export class MyService {
  constructor(
    private readonly repo: MyRepository,
    private readonly other: OtherService,
  ) {}
}
```

This is the documented typedi pattern and what almost every example
on the internet uses. We reject it because it silently breaks at
runtime under Bun.

## Why we rejected it

**Bun does not emit `design:paramtypes` reflect-metadata for decorators.**
typedi's constructor-parameter injection relies on that metadata to
look up the type of each constructor parameter and resolve it
through the container. When the metadata is missing, typedi falls
back to injecting its own `ContainerInstance` into every parameter
slot.

The class then *looks fine* — the parameter "exists", the field is
assigned. But the field is actually the typedi container, not the
service you asked for. The first method call against the "injected"
dep fails with something like:

```
TypeError: this.repo.findById is not a function
```

Tests usually pass (they construct services directly with stubs:
`new MyService(stub)`), so the failure shows up in production only.
This is the worst possible footgun: silent, environment-specific,
caught only by integration tests against the actual container.

**The fix that doesn't work.** A natural-seeming defence:

```ts
@Service()
export class MyService {
  constructor(
    private readonly repo: MyRepository = Container.get(MyRepository),
  ) {}
}
```

This *also* fails. typedi actively passes a value (the bogus
ContainerInstance) for every constructor parameter, so the default
never fires.

**Class-field initialisers run during construction and don't depend
on metadata.** They're plain TypeScript expressions evaluated when
`new MyService()` runs, and `Container.get(...)` doesn't need any
parameter-types metadata to do its job — it takes the class as an
argument.

## The testing pattern

Constructor injection's main upside was easy stubbing:
`new MyService(stubRepo)`. With class-field initialisers, the
stubbing pattern shifts to the container:

```ts
function makeService(stubDep: Dep): MyService {
  Container.set(MyRepository, stubDep);    // seed the container
  const instance = new MyService();         // initialisers read the stub
  Container.set(MyService, instance);       // register the result
  return instance;
}
```

Two important details:

- **Never `Container.reset()`** or `Container.remove(MyService)` —
  either wipes the `@Service()` registration so subsequent
  resolutions of the *real* service fail.
- **Order matters.** Stub the dep on the container *before* `new
  MyService()`, otherwise the class-field initialiser reads the
  real dep (or nothing).

See `BalanceAtTimeService.test.ts` and `PriceGraphService.test.ts`
for canonical examples.

## What this design unlocks

- **Works under Bun without runtime surprises.** The whole monorepo
  is Bun end-to-end; this constraint is non-negotiable.
- **Tests and production share the same DI path.** Both go through
  `Container.get(...)`. No "tests use constructors, production uses
  the container" split.
- **Adding a dependency is a one-line change.** No constructor
  shuffling.

## What the design costs

- **Less idiomatic.** Code reviewers familiar with typedi from
  Node/Nest will reach for constructor injection by reflex; the
  CLAUDE.md and contributor docs catch this.
- **Test setup is slightly more verbose.** Three lines vs `new
  MyService(stub)`.

## What this rules out

- Constructor-parameter injection of any kind in `@Service()`
  classes, including the default-parameter workaround.
- A migration to a different DI container that *does* require
  paramtypes metadata. (Awilix, InversifyJS without
  reflect-metadata, …)

## See also

- [Engineering conventions](/contributing/conventions/)
- [Dependency injection pattern](/contributing/di-pattern/)
- [Testing patterns](/contributing/testing/)
