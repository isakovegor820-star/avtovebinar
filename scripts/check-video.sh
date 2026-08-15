#!/usr/bin/env bash

set -Eeuo pipefail

# The application no longer serves crisis_premium/assets/webinar.mp4 as its
# authoritative source. Keep the public entrypoint, but resolve and probe the
# same configured HLS/MP4 origin that production uses.
exec node scripts/check-webinar-video.mjs "$@"
