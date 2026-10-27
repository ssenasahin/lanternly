import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout, type RouteHandle } from "./app/Layout";
import { AuthLayout } from "./auth/AuthLayout";
import { RedirectIfSignedIn, RequireAuth, SECURITY_PATH } from "./auth/guards";
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
const styleGuide = async () => ({
  Component: (await import("./pages/StyleGuide")).StyleGuidePage,
});
const brand = async () => ({ Component: (await import("./pages/Brand")).BrandPage });

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
          { path: "/incidents", element: <IncidentsPage />, handle: title("Incidents") },
          { path: SECURITY_PATH, element: <SecurityPage />, handle: title("Security") },
          { path: "/styleguide", lazy: styleGuide, handle: title("Style guide") },
          { path: "/brand", lazy: brand, handle: title("Brand") },
          { path: "*", element: <NotFoundPage />, handle: title("Not found") },
        ],
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
