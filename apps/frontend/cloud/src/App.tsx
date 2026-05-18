import { Navigate, Route, Routes } from 'react-router-dom';
import { AnalyticsBridge } from './components/AnalyticsBridge';
import { RequireAuth } from './components/RequireAuth';
import { Shell } from './components/Shell';
import { AuthPage } from './pages/AuthPage';
import { KeysPage } from './pages/KeysPage';
import { UsagePage } from './pages/UsagePage';

export function App() {
  return (
    <>
      <AnalyticsBridge />
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <Shell />
            </RequireAuth>
          }
        >
          <Route index element={<Navigate to="/keys" replace />} />
          <Route path="keys" element={<KeysPage />} />
          <Route path="usage" element={<UsagePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  );
}
