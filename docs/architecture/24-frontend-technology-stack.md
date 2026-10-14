# Frontend Technology Stack

**Status:** Approved foundation

## Purpose

This record defines how the browser application is built. It must carry a long-running conversation, live session events, approvals, diffs, check output, settings, and repository setup without becoming a browser IDE.

## Decisions

- The frontend lives in `apps/web`, written in React 19 and strict TypeScript.
- Vite builds it and serves it locally; the Cloudflare Vite plugin (`@cloudflare/vite-plugin`) runs the Worker in the Workers runtime during development and builds the deployable Worker and assets.
- It is a client-rendered single-page application. No server rendering or React Server Components.
- Routing is React Router in library mode: a route array passed to `createBrowserRouter` (`src/routes/routes.tsx`). The router holds no session state.
- Tailwind CSS 4 provides styling and design tokens.
- shadcn/ui provides component source copied into the repository and owned by OnCue.
- Base UI (`@base-ui-components/react`) is the single interactive-primitive layer under those components.
- Vercel AI Elements provides session-timeline and agent-output component source, copied in on the same terms as shadcn/ui.
- Neither the browser application nor the control plane imports the Vercel AI SDK. It is installed only as a peer of the `agents` package.

## Why a client-rendered React application on Vite

OnCue is an authenticated application, not a content site. Almost everything that matters happens after sign-in and depends on live state: streamed events, approvals, reconnects, and user instructions. A client-rendered React application keeps that direct, while the Cloudflare control plane stays responsible for authentication, authorization, durable session state, and APIs.

Vite is a focused build layer with first-party Cloudflare support, so local development runs the same Worker code and bindings as the hosted build. Full-stack server-rendering frameworks and other bundlers were considered; they add a second application model or more custom Cloudflare integration without meeting an MVP need (`../decisions.md`).

## Why shadcn/ui and Base UI

shadcn/ui components are source files in `apps/web/src/components/ui/`, edited and tested like any other code, which suits specialized surfaces such as the timeline, activity rows, approval controls, and diff views. OnCue's tokens, spacing, typography, and composition define the appearance, not the library. `components.json` configures the `new-york` style with CSS variables and `rsc: false`.

Base UI handles focus, keyboard operation, dismissal, overlays, and accessibility semantics, and shadcn supports it as a primitive layer for new projects. Only one primitive foundation is used, because similar-looking components from different foundations have different composition and event APIs. No `@radix-ui` package is a dependency.

## Why Vercel AI Elements

AI Elements is an Apache 2.0 component registry for agent interfaces, installed by copying source into `apps/web/src/components/ai-elements/`. OnCue keeps only the components it renders: messages, the conversation scroller, code blocks, commits, and file trees. Components it did not use were removed rather than kept as unused source.

OnCue takes the presentation, not the data model. A component that imports AI SDK message types imports a local replacement from `src/components/ai-elements/types.ts` instead, and the timeline passes it data derived from OnCue's own protocol. Shared building blocks resolve to OnCue's Base UI components.

Re-running the install command overwrites local edits, so a component is updated deliberately and reviewed, never re-copied wholesale.

### Why not the Vercel AI SDK

In the browser, the SDK's chat state assumes the client owns the message list and streams from an HTTP route. OnCue's history is an ordered event log owned by the session Durable Object, with sequence numbers, replay after reconnect, gap detection, and many non-message events. In the control plane, the Model Broker is a credential proxy, not a model client: OpenCode in the sandbox speaks the provider's API, and re-serializing through a general abstraction would lose fidelity (record 06). If the control plane ever needs to call a model directly, the SDK can be reconsidered for that job.

## What is in the repository

- **AI Elements** (`src/components/ai-elements/`): Code Block, Commit, Conversation, File Tree, and Message. The change card and the review panel's file tree build on Commit and File Tree. Neither registry has a line-level diff view, so the diff renderer and unified-diff parser in `src/features/diff/` are OnCue's own.
- **shadcn/ui** (`src/components/ui/`): Button, Collapsible, Dialog, Dropdown Menu, Popover, Resizable, and Tooltip. Collapsible is written over Base UI so AI Elements resolves to it; Resizable wraps `react-resizable-panels`, a layout component with no Base UI equivalent.
- **Brand** (`src/components/brand/`): the marks of the providers and harnesses OnCue integrates with (`icons.tsx`), which belong to their owners and are shown only to identify each service, and OnCue's own wordmarks.
- Other runtime dependencies the copied components bring: `streamdown` (Markdown), `shiki` (code highlighting), `use-stick-to-bottom`, and `lucide-react` icons.

## Directory layout

```text
apps/web/
├── src/
│   ├── components/{ui,ai-elements,brand}/
│   ├── features/     product areas (session, diff, verification, settings, setup, ...)
│   ├── routes/       route table and shell
│   ├── lib/          API clients and browser utilities
│   ├── styles/       globals.css and tokens.css
│   ├── dev/          dev-only harnesses the build refuses to ship
│   └── main.tsx
├── vite-plugins/     dev-only inspector and harness plugins
├── worker/           the control plane (record 01)
├── e2e/              Playwright suite (record 23)
├── components.json
└── vite.config.ts
```

Product-specific components stay with their feature; reusable primitives stay in `components/ui`. `pnpm build` fails if the bundle contains the dev inspector, a dev harness, or anything shaped like a secret.

## Design-system rules

- Use semantic tokens for surfaces, text, borders, status, and focus, not raw colors; light and dark themes share token names.
- Keep keyboard behavior, visible focus, reduced motion, and screen-reader labels intact when customizing components.
- Prefer composition over changing a shared primitive for one screen.
- Add only components the product uses.
- Treat copied shadcn and AI Elements files as maintained source, covered by tests and review (`ai-elements.test.tsx`, `review-elements.test.tsx`, `ui.test.tsx`).

## Boundaries

- The browser requests actions; the control plane makes authorization and policy decisions.
- No provider credential, repository secret, GitHub App credential, or infrastructure key enters the bundle. Only the Clerk publishable key, which is public, is inlined.
- Durable history comes from committed server events. Streaming state in React is not the system of record, and no frontend library duplicates the Durable Object's ownership of the session.
- Large logs and artifacts load through authorized references, not the main payload.

## Not built yet

The application preview panel. The plan is to serve previews from a separate registrable domain, embedded cross-origin, so the application origin never runs repository code (`../roadmap.md`).

## Sources

- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [shadcn/ui documentation](https://ui.shadcn.com/docs)
- [Vercel AI Elements](https://elements.ai-sdk.dev)

## Conditions for reconsideration

Revisit if the product gains public content that needs server rendering, the Cloudflare Vite integration stops supporting a required Worker capability, build performance becomes a real constraint, a necessary component ecosystem cannot work with Base UI, AI Elements changes its primitive layer in a way that conflicts with Base UI, or the control plane genuinely needs to call a model directly.
