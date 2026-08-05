---
"@chenshaohui6988/sandcastle": patch
---

Harden Company Runtime event-registry version handling on both reader paths. AG-UI and ACP now share a single choke point that rejects any envelope whose registry version is newer than the running registry (or below the version floor), and both fail closed on such an event instead of forwarding it. The AG-UI diagnostic for an unsupported registry version is now marked non-retryable, since a version-too-new envelope can never become readable by retrying. Forward-only compatibility with older-but-supported registry versions is preserved.
