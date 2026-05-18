---
"task-master-ai": patch
---

Fix markdown rendering corruption when task details contain angle brackets (e.g. JSX/TSX such as `<Navigate to="/" replace />`) inside fenced code blocks. HTML detection now ignores content inside code blocks, so code samples are no longer mangled by the HTML-to-Markdown converter.
