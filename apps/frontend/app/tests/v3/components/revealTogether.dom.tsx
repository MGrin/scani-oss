import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { RevealTogether } from '@/v3/components/feedback/RevealTogether';

/**
 * SC-1742. A section whose parts answer one by one is shown once, together:
 * its children mount at once (so their queries start), stay hidden behind one
 * skeleton while any of them is still on its FIRST load, and are revealed when
 * none is, or at the cap. Runs in the DOM process `dom-specs.ts` starts.
 *
 * **No wall clock anywhere.** Time is fake, and every query answers only when
 * the test says so. The first version slept real milliseconds and measured
 * them with `Date.now`, so on a busy CI box the budget ran out before the
 * timers it waited on had fired: main build #1886 went red on a margin of
 * 10 ms. Here a step of time is exactly that step, however slow the box.
 */

/** One query's answers, released by hand. Each call to `fn` is a new fetch. */
function controlled<T>() {
  const waiting: Array<(value: T) => void> = [];
  return {
    fn: () => new Promise<T>((resolve) => waiting.push(resolve)),
    answer: async (value: T) => {
      await act(async () => {
        for (const resolve of waiting.splice(0)) resolve(value);
      });
    },
  };
}

/** Fake time, advanced in small steps with effects flushed between them, the
 *  way a browser sees it: one long jump would start every chained timer late. */
async function advance(ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 5) {
    await act(async () => {
      jest.advanceTimersByTime(Math.min(5, ms - elapsed));
    });
  }
}

function Part({ name, fn }: { name: string; fn: () => Promise<string> }) {
  const query = useQuery({ queryKey: [name], queryFn: fn });
  return <p>{query.data ?? `${name} loading`}</p>;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  jest.useRealTimers();
});

function mount(client: QueryClient, children: React.ReactNode, capMs: number) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <RevealTogether capMs={capMs} skeleton={<p>skeleton</p>}>
          {children}
        </RevealTogether>
      </QueryClientProvider>
    )
  );
}

const shown = () => {
  const box = host?.querySelector('[data-reveal]');
  return box !== null && box !== undefined && !box.hasAttribute('hidden');
};

describe('RevealTogether', () => {
  test('holds every part back until the slowest first load answers', async () => {
    const a = controlled<string>();
    const b = controlled<string>();
    mount(
      new QueryClient(),
      [<Part key="a" name="a" fn={a.fn} />, <Part key="b" name="b" fn={b.fn} />],
      2000
    );
    await advance(20);
    await a.answer('a');
    // `a` has answered, `b` has not: nothing is shown, however long `b` takes
    // short of the cap, and both are mounted.
    await advance(500);
    expect(shown()).toBe(false);
    expect(host?.textContent).toContain('a');
    await b.answer('b');
    await advance(100);
    expect(shown()).toBe(true);
    expect(host?.textContent).toContain('b');
  });

  test('shows what it has at the cap rather than wait on a slow part', async () => {
    const a = controlled<string>();
    const slow = controlled<string>();
    mount(
      new QueryClient(),
      [<Part key="a" name="a" fn={a.fn} />, <Part key="slow" name="slow" fn={slow.fn} />],
      150
    );
    await advance(10);
    await a.answer('a');
    await advance(100);
    expect(shown()).toBe(false);
    await advance(60);
    expect(shown()).toBe(true);
    expect(host?.textContent).toContain('slow loading');
  });

  test('does not wait on a query that already has data and is only refreshing', async () => {
    const client = new QueryClient();
    client.setQueryData(['cached'], 'cached');
    client
      .getQueryCache()
      .find({ queryKey: ['cached'] })
      ?.invalidate();
    const refresh = controlled<string>();
    mount(client, <Part name="cached" fn={refresh.fn} />, 2000);
    // The refresh never answers: a reveal here is not waiting on it.
    await advance(100);
    expect(shown()).toBe(true);
  });

  test('waits for a second question a part asks once its first is answered', async () => {
    // The household section asks for accounts only after `household.mine`.
    // Its second query starts a moment after the first answers, as a child
    // that mounts from an effect does: in that moment nothing is in flight.
    const first = controlled<number>();
    const second = controlled<string>();
    function Waterfall() {
      const answer = useQuery({ queryKey: ['first'], queryFn: first.fn });
      const [next, setNext] = useState(false);
      useEffect(() => {
        if (answer.data !== undefined) setTimeout(() => setNext(true), 10);
      }, [answer.data]);
      return next ? <Part name="second" fn={second.fn} /> : <p>first loading</p>;
    }
    mount(new QueryClient(), <Waterfall />, 2000);
    await advance(20);
    await first.answer(1);
    await advance(500);
    expect(shown()).toBe(false);
    expect(host?.textContent).toContain('second loading');
    await second.answer('second');
    await advance(100);
    expect(shown()).toBe(true);
    expect(host?.textContent).toContain('second');
  });

  test('stays on the skeleton while held, and counts the cap from the release', async () => {
    const client = new QueryClient();
    const slow = controlled<string>();
    const render = (hold: boolean) =>
      root?.render(
        <QueryClientProvider client={client}>
          <RevealTogether hold={hold} capMs={100} skeleton={<p>skeleton</p>} skeletonRamps>
            {hold ? null : <Part name="slow" fn={slow.fn} />}
          </RevealTogether>
        </QueryClientProvider>
      );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => render(true));
    await advance(200);
    expect(shown()).toBe(false);
    expect(host.textContent).toContain('skeleton');
    act(() => render(false));
    await advance(50);
    expect(shown()).toBe(false);
    await advance(60);
    expect(shown()).toBe(true);
  });

  test('never hides again once shown', async () => {
    const client = new QueryClient();
    const a = controlled<string>();
    mount(client, <Part name="a" fn={a.fn} />, 2000);
    await advance(10);
    await a.answer('a');
    await advance(100);
    expect(shown()).toBe(true);
    // A reset puts the query back on a first load, which never answers here.
    await act(async () => {
      void client.resetQueries();
    });
    await advance(100);
    expect(shown()).toBe(true);
  });
});
