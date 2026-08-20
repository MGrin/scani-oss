import { describe, expect, test } from 'bun:test';
import { Container, Service, Token } from 'typedi';
import {
  containerRegistrations,
  restoreContainerAfterAll,
  snapshotContainer,
} from '../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

@Service()
class RealDependency {
  answer(): string {
    return 'real';
  }
}

@Service()
class RealConsumer {
  private readonly dependency = Container.get(RealDependency);

  ask(): string {
    return this.dependency.answer();
  }
}

const UNBOUND_TOKEN = new Token<{ answer(): string }>('sc448-unbound');

describe('snapshotContainer', () => {
  test('reaches typedi 0.10s registration array', () => {
    const registry = containerRegistrations();
    expect(Array.isArray(registry)).toBe(true);
    expect(registry.some((registration) => registration.id === RealDependency)).toBe(true);
  });

  test('undoes a stub so a later reader resolves the real @Service()', () => {
    expect(Container.get(RealConsumer).ask()).toBe('real');

    const restore = snapshotContainer();
    Container.set(RealDependency, { answer: () => 'stub' } as RealDependency);
    Container.set(RealConsumer, new RealConsumer());
    expect(Container.get(RealConsumer).ask()).toBe('stub');

    restore();

    expect(Container.get(RealDependency).answer()).toBe('real');
    expect(Container.get(RealConsumer).ask()).toBe('real');
  });

  test('drops a binding the test invented rather than leaving it behind', () => {
    const restore = snapshotContainer();
    Container.set(UNBOUND_TOKEN, { answer: () => 'stub' });
    expect(Container.has(UNBOUND_TOKEN)).toBe(true);

    restore();

    expect(Container.has(UNBOUND_TOKEN)).toBe(false);
  });

  test('puts back a registration the test removed', () => {
    const restore = snapshotContainer();
    Container.remove(RealDependency);
    expect(Container.has(RealDependency)).toBe(false);

    restore();

    expect(Container.has(RealDependency)).toBe(true);
    expect(Container.get(RealDependency).answer()).toBe('real');
  });

  test('leaves the container untouched when the file stubs nothing', () => {
    const before = containerRegistrations().length;
    const restore = snapshotContainer();
    restore();
    expect(containerRegistrations().length).toBe(before);
    expect(Container.get(RealDependency).answer()).toBe('real');
  });
});
