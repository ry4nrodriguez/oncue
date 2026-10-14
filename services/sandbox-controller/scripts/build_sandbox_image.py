"""Build the sandbox image in the operator's own Modal workspace.

Modal caches an image per workspace and a build takes minutes. Each user's
workspace is prepared by the controller's `/v1/prepareImage`; this warms the
workspace of the Modal profile it runs under, for `pnpm controller` and the
operator's own sessions.
"""

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import modal  # noqa: E402

import images  # noqa: E402

APP_NAME = "oncue-sessions"


def main() -> int:
    started = time.monotonic()
    app = modal.App.lookup(APP_NAME, create_if_missing=True)
    with modal.enable_output():
        image = images.base_image().build(app)
    print(
        f"[build-sandbox-image] {image.object_id} ready in {time.monotonic() - started:.1f}s",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
