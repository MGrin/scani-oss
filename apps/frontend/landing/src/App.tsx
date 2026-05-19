import { useEffect } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { useSystemPreferences } from './hooks/useSystemPreferences';
import { routes } from './routes';

const router = createBrowserRouter(routes);

export function App() {
  const { theme } = useSystemPreferences();

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    root.classList.toggle('light', theme === 'light');
    root.dataset.theme = theme;
  }, [theme]);

  return <RouterProvider router={router} />;
}
