# Third-party notices

OnCue is licensed under the Apache License, Version 2.0 (see `LICENSE`). Some
files in this repository began as material from other projects. This file
carries their notices, and says which trademarks appear in the repository.
Packages installed from the npm and PyPI registries are not listed here; each
ships its own licence.

## Vercel AI Elements

Files: `apps/web/src/components/ai-elements/code-block.tsx`, `commit.tsx`,
`conversation.tsx`, `file-tree.tsx`, and `message.tsx`.

Source: <https://github.com/vercel/ai-elements>

These files are derived from AI Elements and have been changed for OnCue: only
the components OnCue renders are kept, types the originals import from the
Vercel AI SDK are replaced by local ones in `types.ts`, and the components
resolve to OnCue's own Base UI primitives.

```
Copyright 2023 Vercel, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## shadcn/ui

Files: `apps/web/src/components/ui/`, the `cn` helper in
`apps/web/src/lib/utils.ts`, and the configuration in `apps/web/components.json`.

Source: <https://github.com/shadcn-ui/ui>

The component files began as shadcn/ui source and have been changed for OnCue:
most are rewritten over Base UI primitives, and the resizable panels wrap
`react-resizable-panels`.

```
MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## OpenCode

File: `services/bridge/fixtures/opencode-openapi-1.18.30.json`.

Source: <https://github.com/anomalyco/opencode>

This file is an extract of the OpenAPI document OpenCode 1.18.30 serves, kept
so the bridge's contract tests can read the schemas they depend on. The
recordings beside it (`*-recorded.jsonl`) are output captured from running
OpenCode and Codex, not their source.

```
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Trademarks and logos

`apps/web/src/components/brand/icons.tsx` draws the marks of services OnCue
integrates with: GitHub, Anthropic and Claude, OpenAI, Modal, OpenCode, and
Pi. Those marks, and the names of these and other products mentioned in the
code and documentation, are trademarks of their respective owners. They are
not licensed under the Apache License, and the licence on this repository
grants no right to use them. OnCue shows them only to identify the service a
control or a setting belongs to. OnCue is not affiliated with, sponsored by,
or endorsed by any of these companies.

If you redistribute OnCue or run it for others, your use of these marks is
subject to each owner's own brand guidelines.
