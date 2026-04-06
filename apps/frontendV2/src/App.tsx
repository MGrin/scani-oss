import { Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { V2App } from '@/v2/V2App';
import { AuthProvider } from '@/contexts/AuthContext';
import { AccountDetail } from '@/pages/AccountDetail';
import { Accounts } from '@/pages/Accounts';
import { AddData } from '@/pages/AddData';
import { Auth } from '@/pages/Auth';
import { AuthCallback } from '@/pages/AuthCallback';
import { Dashboard } from '@/pages/Dashboard';
import { Groups } from '@/pages/Groups';
import { HoldingDetail } from '@/pages/HoldingDetail';
import { Holdings } from '@/pages/Holdings';
import { InstitutionDetail } from '@/pages/InstitutionDetail';
import { Institutions } from '@/pages/Institutions';
import { Settings } from '@/pages/Settings';
import { VaultDetail } from '@/pages/VaultDetail';
import { Vaults } from '@/pages/Vaults';

function App() {
  return (
    <AuthProvider>
      <Router
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <Routes>
          {/* Public routes */}
          <Route path="/auth" element={<Auth />} />
          <Route path="/signin" element={<Auth />} />
          <Route path="/signup" element={<Auth />} />
          <Route path="/auth/callback" element={<AuthCallback />} />

          {/* Protected routes with layout */}
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <Layout>
                  <Dashboard />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/holdings"
            element={
              <ProtectedRoute>
                <Layout>
                  <Holdings />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/institutions"
            element={
              <ProtectedRoute>
                <Layout>
                  <Institutions />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/accounts"
            element={
              <ProtectedRoute>
                <Layout>
                  <Accounts />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/groups"
            element={
              <ProtectedRoute>
                <Layout>
                  <Groups />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/vaults"
            element={
              <ProtectedRoute>
                <Layout>
                  <Vaults />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/vaults/:id"
            element={
              <ProtectedRoute>
                <Layout>
                  <VaultDetail />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/add-data"
            element={
              <ProtectedRoute>
                <Layout>
                  <AddData />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/settings"
            element={
              <ProtectedRoute>
                <Layout>
                  <Settings />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/accounts/:id"
            element={
              <ProtectedRoute>
                <Layout>
                  <AccountDetail />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/institutions/:id"
            element={
              <ProtectedRoute>
                <Layout>
                  <InstitutionDetail />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/holdings/:id"
            element={
              <ProtectedRoute>
                <Layout>
                  <HoldingDetail />
                </Layout>
              </ProtectedRoute>
            }
          />
          {/* V2 UI */}
          <Route
            path="/v2/*"
            element={
              <ProtectedRoute>
                <V2App />
              </ProtectedRoute>
            }
          />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

export default App;
