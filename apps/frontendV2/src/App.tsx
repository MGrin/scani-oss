import { Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { Layout } from '@/components/layout';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { AuthProvider } from '@/contexts/AuthContext';
import { AccountDetail } from '@/pages/AccountDetail';
import { Accounts } from '@/pages/Accounts';
import { AddData } from '@/pages/AddData';
import { Auth } from '@/pages/Auth';
import { AuthCallback } from '@/pages/AuthCallback';
import { Dashboard } from '@/pages/Dashboard';
import { HoldingDetail } from '@/pages/HoldingDetail';
import { Holdings } from '@/pages/Holdings';
import { InstitutionDetail } from '@/pages/InstitutionDetail';
import { Institutions } from '@/pages/Institutions';
import { ScheduleCreate } from '@/pages/ScheduleCreate';
import { ScheduleDetail } from '@/pages/ScheduleDetail';
import { Schedules } from '@/pages/Schedules';
import { Settings } from '@/pages/Settings';

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
            path="/add-data"
            element={
              <ProtectedRoute>
                <Layout>
                  <AddData />
                </Layout>
              </ProtectedRoute>
            }
          />
          {/* <Route
            path="/reports"
            element={
              <ProtectedRoute>
                <Layout>
                  <Reports />
                </Layout>
              </ProtectedRoute>
            }
          /> */}
          <Route
            path="/schedules"
            element={
              <ProtectedRoute>
                <Layout>
                  <Schedules />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/schedules/new"
            element={
              <ProtectedRoute>
                <Layout>
                  <ScheduleCreate />
                </Layout>
              </ProtectedRoute>
            }
          />
          <Route
            path="/schedules/:id"
            element={
              <ProtectedRoute>
                <Layout>
                  <ScheduleDetail />
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
        </Routes>
      </Router>
    </AuthProvider>
  );
}

export default App;
