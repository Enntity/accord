#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Optional development-only tokenizer; install tiktoken outside the product."""
import json, sys
import tiktoken

def serialized(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))

results = {}
for file in sys.argv[1:]:
    data = json.load(open(file))
    results[file] = {}
    for encoding in ('o200k_base', 'cl100k_base'):
        encoder = tiktoken.get_encoding(encoding)
        count = lambda value: len(encoder.encode(serialized(value)))
        results[file][encoding] = {
            'tool_catalog_tokens': count(data['tools']),
            'first_inbox_page_tokens': count(data['pages'][0]['response']),
            'full_backlog_workflow_tokens': sum(count(p['request']) + count(p['response']) for p in data['pages']),
            'pages': len(data['pages']),
        }
print(json.dumps(results, indent=2))
