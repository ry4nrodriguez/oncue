import { RouterProvider } from "react-router";
import { createAppRouter } from "./routes/routes";

const router = createAppRouter();

/** The signed-in app. `main.tsx` supplies the theme above the auth gate. */
export function App() {
  return <RouterProvider router={router} />;
}
