import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout, type RouteHandle } from "./app/Layout";
import { AuthLayout } from "./auth/AuthLayout";
import { RedirectIfSignedIn, RequireAuth, SECURITY_PATH } from "./auth/guards";
import { ForgotPasswordPage } from "./pages/auth/ForgotPassword";
import { ResetPasswordPage } from "./pages/auth/ResetPassword";
import { SignInPage } from "./pages/auth/SignIn";
import { SignUpPage } from "./pages/auth/SignUp";
import { BrandPage } from "./pages/Brand";
import { IncidentsPage } from "./pages/Incidents";
import { MonitorDetailPage } from "./pages/monitors/MonitorDetail";
import { MonitorFormPage } from "./pages/monitors/MonitorForm";
import { MonitorListPage } from "./pages/monitors/MonitorList";
import { NotFoundPage } from "./pages/NotFound";
import { SecurityPage } from "./pages/settings/Security";
import { StyleGuidePage } from "./pages/StyleGuide";

const title = (t: string): RouteHandle => ({ title: t });

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
          { path: "/monitors/new", element: <MonitorFormPage />, handle: title("Add monitor") },
          { path: "/monitors/:id", element: <MonitorDetailPage />, handle: title("Monitor") },
          {
            path: "/monitors/:id/edit",
            element: <MonitorFormPage />,
            handle: title("Edit monitor"),
          },
          { path: "/incidents", element: <IncidentsPage />, handle: title("Incidents") },
          { path: SECURITY_PATH, element: <SecurityPage />, handle: title("Security") },
          { path: "/styleguide", element: <StyleGuidePage />, handle: title("Style guide") },
          { path: "/brand", element: <BrandPage />, handle: title("Brand") },
          { path: "*", element: <NotFoundPage />, handle: title("Not found") },
        ],
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
