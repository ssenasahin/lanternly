import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout, type RouteHandle } from "./app/Layout";
import { AuthLayout } from "./auth/AuthLayout";
import { RedirectIfSignedIn, RequireAdmin, RequireAuth, SECURITY_PATH } from "./auth/guards";
import { ForgotPasswordPage } from "./pages/auth/ForgotPassword";
import { ResetPasswordPage } from "./pages/auth/ResetPassword";
import { SignInPage } from "./pages/auth/SignIn";
import { SignUpPage } from "./pages/auth/SignUp";
import { IncidentsPage } from "./pages/Incidents";
import { MonitorDetailPage } from "./pages/monitors/MonitorDetail";
import { MonitorListPage } from "./pages/monitors/MonitorList";
import { NotFoundPage } from "./pages/NotFound";
import { SecurityPage } from "./pages/settings/Security";

const title = (t: string): RouteHandle => ({ title: t });

// Pages most visits never open load on demand, keeping the first download small:
// the form brings zod and react-hook-form, the design pages bring the brand assets.
const monitorForm = async () => ({
  Component: (await import("./pages/monitors/MonitorForm")).MonitorFormPage,
});
const heartbeatForm = async () => ({
  Component: (await import("./pages/heartbeats/HeartbeatForm")).HeartbeatFormPage,
});
const styleGuide = async () => ({
  Component: (await import("./pages/StyleGuide")).StyleGuidePage,
});
const brand = async () => ({ Component: (await import("./pages/Brand")).BrandPage });
const channels = async () => ({
  Component: (await import("./pages/alerts/Channels")).ChannelsPage,
});
const escalation = async () => ({
  Component: (await import("./pages/alerts/Escalation")).EscalationPage,
});
const team = async () => ({ Component: (await import("./pages/alerts/Team")).TeamPage });
const invite = async () => ({ Component: (await import("./pages/alerts/Invite")).InvitePage });
const incident = async () => ({
  Component: (await import("./pages/incidents/IncidentDetail")).IncidentDetailPage,
});
const acknowledge = async () => ({
  Component: (await import("./pages/incidents/Acknowledge")).AcknowledgePage,
});
const agentNew = async () => ({
  Component: (await import("./pages/agents/AgentNew")).AgentNewPage,
});
const apiKeys = async () => ({
  Component: (await import("./pages/settings/ApiKeys")).ApiKeysPage,
});

const adminUsers = async () => ({
  Component: (await import("./pages/admin/AdminUsers")).AdminUsersPage,
});
const adminUser = async () => ({
  Component: (await import("./pages/admin/AdminUser")).AdminUserPage,
});
const systemHealth = async () => ({
  Component: (await import("./pages/admin/SystemHealth")).SystemHealthPage,
});
const auditLog = async () => ({
  Component: (await import("./pages/admin/AuditLog")).AuditLogPage,
});
const plans = async () => ({ Component: (await import("./pages/admin/Plans")).PlansPage });

const router = createBrowserRouter([
  {
    element: <AuthLayout />,
    children: [
      {
        element: <RedirectIfSignedIn />,
        children: [
          { path: "/sign-in", element: <SignInPage />, handle: title("Sign in") },
          { path: "/sign-up", element: <SignUpPage />, handle: title("Create account") },
        ],
      },
      {
        path: "/forgot-password",
        element: <ForgotPasswordPage />,
        handle: title("Reset password"),
      },
      { path: "/reset-password", element: <ResetPasswordPage />, handle: title("New password") },
      // Opened from an alert, often on a phone with no session: the link's signature
      // is the permission, so it sits outside the sign-in guard.
      { path: "/ack/:id", lazy: acknowledge, handle: title("Acknowledge") },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <Layout />,
        children: [
          { path: "/", element: <MonitorListPage />, handle: title("Monitors") },
          { path: "/monitors/new", lazy: monitorForm, handle: title("Add monitor") },
          { path: "/monitors/:id", element: <MonitorDetailPage />, handle: title("Monitor") },
          {
            path: "/monitors/:id/edit",
            lazy: monitorForm,
            handle: title("Edit monitor"),
          },
          { path: "/heartbeats/new", lazy: heartbeatForm, handle: title("Add heartbeat") },
          {
            path: "/heartbeats/:id/edit",
            lazy: heartbeatForm,
            handle: title("Edit heartbeat"),
          },
          { path: "/agents/new", lazy: agentNew, handle: title("Add server") },
          { path: "/incidents", element: <IncidentsPage />, handle: title("Incidents") },
          { path: "/incidents/:id", lazy: incident, handle: title("Incident") },
          { path: "/channels", lazy: channels, handle: title("Channels") },
          { path: "/escalation", lazy: escalation, handle: title("Escalation") },
          { path: "/team", lazy: team, handle: title("Team") },
          { path: "/invites/:token", lazy: invite, handle: title("Team invite") },
          { path: SECURITY_PATH, element: <SecurityPage />, handle: title("Security") },
          { path: "/settings/api-keys", lazy: apiKeys, handle: title("API keys") },
          { path: "/styleguide", lazy: styleGuide, handle: title("Style guide") },
          { path: "/brand", lazy: brand, handle: title("Brand") },
          {
            element: <RequireAdmin />,
            children: [
              { path: "/admin/users", lazy: adminUsers, handle: title("Users") },
              { path: "/admin/users/:id", lazy: adminUser, handle: title("User") },
              { path: "/admin/system", lazy: systemHealth, handle: title("System health") },
              { path: "/admin/audit", lazy: auditLog, handle: title("Audit log") },
              { path: "/admin/plans", lazy: plans, handle: title("Plans") },
            ],
          },
          { path: "*", element: <NotFoundPage />, handle: title("Not found") },
        ],
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
