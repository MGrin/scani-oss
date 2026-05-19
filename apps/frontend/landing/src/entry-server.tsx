import { renderToString } from 'react-dom/server';
import {
  createStaticHandler,
  createStaticRouter,
  StaticRouterProvider,
} from 'react-router-dom/server';
import { routes } from './routes';

/**
 * Build-time render entry. The prerender script loads this through
 * Vite's SSR pipeline (`ssrLoadModule`) so `import.meta.env`, the
 * `__BUILD_ID__` define, and JSX are all transformed, then calls
 * `render(path)` for each route to produce static body HTML.
 */
export async function render(path: string): Promise<string> {
  const { query, dataRoutes } = createStaticHandler(routes);
  const context = await query(new Request(`http://localhost${path}`));
  if (context instanceof Response) {
    throw new Error(`Prerender ${path}: route returned a redirect/response`);
  }
  const router = createStaticRouter(dataRoutes, context);
  return renderToString(<StaticRouterProvider router={router} context={context} hydrate={false} />);
}
