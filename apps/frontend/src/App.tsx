import { Route, BrowserRouter as Router, Routes } from 'react-router-dom';
import { Layout } from '@/components/Layout';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Toaster } from '@/components/ui/toaster';
import { AuthProvider } from '@/contexts/AuthContext';
import { ThemeLoader, ThemeProvider } from '@/contexts/ThemeContext';
import { SessionStatusIndicator, SessionTimeoutProvider } from '@/hooks/useSessionTimeout';
import { TRPCProvider } from '@/lib/trpc-provider';
import { Accounts } from '@/pages/Accounts';
import { Analytics } from '@/pages/Analytics';
import { Auth } from '@/pages/Auth';
import { AuthCallback } from '@/pages/AuthCallback';
import { Dashboard } from '@/pages/Dashboard';
import { Holdings } from '@/pages/Holdings';
import { Institutions } from '@/pages/Institutions';
import { Settings } from '@/pages/Settings';
import { Transactions } from '@/pages/Transactions';

function App() {
  // Handle session timeout - in a real app this would trigger logout/redirect
  const handleSessionTimeout = () => {
    console.warn('Session expired due to inactivity');
    // Here you would typically:
    // 1. Clear user session/tokens
    // 2. Redirect to login page
    // 3. Show appropriate messaging
    // For demo purposes, we'll just log a warning
  };

  return (
    <AuthProvider>
      <TRPCProvider>
        <ThemeProvider>
          <ThemeLoader>
            <SessionTimeoutProvider
              onTimeout={handleSessionTimeout}
              config={{
                timeoutMinutes: 30, // 30 minute timeout
                warningMinutes: 5, // Show warning 5 minutes before
                checkIntervalSeconds: 30, // Check every 30 seconds
              }}
            >
              <Router>
                <Routes>
                  {/* Public routes */}
                  <Route path="/auth" element={<Auth />} />
                  <Route path="/signin" element={<Auth />} />
                  <Route path="/signup" element={<Auth />} />
                  <Route path="/auth/callback" element={<AuthCallback />} />

                  {/* Protected routes */}
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
                    path="/analytics"
                    element={
                      <ProtectedRoute>
                        <Layout>
                          <Analytics />
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
                    path="/transactions"
                    element={
                      <ProtectedRoute>
                        <Layout>
                          <Transactions />
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
                    path="/settings"
                    element={
                      <ProtectedRoute>
                        <Layout>
                          <Settings />
                        </Layout>
                      </ProtectedRoute>
                    }
                  />
                </Routes>
                <SessionStatusIndicator />
              </Router>
              <Toaster />
            </SessionTimeoutProvider>
          </ThemeLoader>
        </ThemeProvider>
      </TRPCProvider>
    </AuthProvider>
  );
}

export default App;
