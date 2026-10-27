import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout, type RouteHandle } from "./app/Layout";
import { BrandPage } from "./pages/Brand";
import { IncidentsPage } from "./pages/Incidents";
import { MonitorsPage } from "./pages/Monitors";
import { NotFoundPage } from "./pages/NotFound";
import { StyleGuidePage } from "./pages/StyleGuide";

const title = (t: string): RouteHandle => ({ title: t });

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <MonitorsPage />, handle: title("Monitors") },
      { path: "/incidents", element: <IncidentsPage />, handle: title("Incidents") },
      { path: "/styleguide", element: <StyleGuidePage />, handle: title("Style guide") },
      { path: "/brand", element: <BrandPage />, handle: title("Brand") },
      { path: "*", element: <NotFoundPage />, handle: title("Not found") },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
