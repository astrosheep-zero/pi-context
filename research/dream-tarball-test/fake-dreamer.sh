#!/bin/sh
# fake dreamer: stdin=playbook (ignored), stdout=one JSON manifest
cat > /dev/null
printf '{"report": "fake dreamer OK — playbook received, manifest returned"}\n'
